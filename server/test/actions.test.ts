import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ActionDesk, UNDO_MS, PREVIEW_TTL_MS, baseSize, coinbaseOrders, type OrderRequest } from '../src/actions.ts'
import { PaperLedger } from '../src/ledger.ts'

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)

function rig(opts: { fail?: string } = {}) {
  let now = Date.UTC(2026, 10, 23, 9)
  const timers: { at: number; fn: () => void; id: number }[] = []
  let tid = 0
  let n = 0
  const sent: OrderRequest[] = []
  const quotes: Record<string, { bid: number; ask: number }> = { 'BTC-USD': { bid: 61000, ask: 61001 } }
  const ledger = new PaperLedger()
  ledger.apply({ id: 'seed', product: 'BTC-USD', side: 'BUY', qty: 0.02, price: 60000, t: now - 3600_000 })
  const desk = new ActionDesk({
    ledger,
    quote: (p) => quotes[p] ?? null,
    placeOrder: async (req) => { sent.push(req); return opts.fail ? { ok: false, reason: opts.fail } : { ok: true, orderId: 'ord-' + sent.length } },
    now: () => now,
    setTimer: (fn, ms) => { timers.push({ at: now + ms, fn, id: ++tid }); return tid },
    clearTimer: (h) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1) },
    newId: () => `a${++n}`,
  })
  const advance = async (ms: number) => {
    const end = now + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const t = timers[0]
      if (!t || t.at > end) break
      timers.shift()
      now = t.at
      t.fn()
      await new Promise((r) => setImmediate(r))
    }
    now = end
  }
  return { desk, ledger, sent, quotes, advance, get now() { return now } }
}

test('preview halve: sells half at the bid, fee and net computed, nothing sent', () => {
  const r = rig()
  const p = r.desk.preview('halve', 'BTC-USD')
  assert.equal(p.side, 'SELL')
  close(p.qty, 0.01)
  assert.equal(p.estPrice, 61000)
  close(p.estFee, 610 * 0.008)
  close(p.estNet, 610 - 4.88)
  close(p.exposureAfter, 0.01)
  assert.equal(r.sent.length, 0)
})

test('undo inside the window: no request is ever sent, ledger untouched', async () => {
  const r = rig()
  const p = r.desk.preview('close', 'BTC-USD')
  r.desk.confirm(p.id)
  await r.advance(UNDO_MS - 1)
  assert.equal(r.desk.undo(p.id).status, 'undone')
  await r.advance(10_000)
  assert.equal(r.sent.length, 0)
  close(r.ledger.qty('BTC-USD'), 0.02)
})

test('after the window: one order with client_order_id = action id, fill booked at the execution-time bid', async () => {
  const r = rig()
  const p = r.desk.preview('halve', 'BTC-USD')
  r.desk.confirm(p.id)
  r.desk.confirm(p.id) // double tap
  r.quotes['BTC-USD'] = { bid: 61100, ask: 61101 } // market moved during the countdown
  await r.advance(UNDO_MS)
  assert.equal(r.sent.length, 1)
  assert.equal(r.sent[0].client_order_id, p.id)
  assert.deepEqual(r.sent[0].order_configuration, { market_market_ioc: { base_size: '0.01' } })
  const s = r.desk.get(p.id)!
  assert.equal(s.status, 'filled')
  if (s.status === 'filled') assert.equal(s.fill.price, 61100)
  close(r.ledger.qty('BTC-USD'), 0.01)
  assert.equal(r.desk.undo(p.id).status, 'filled') // too late to undo
})

test('stale or drifted previews are refused at confirm', () => {
  const r = rig()
  const p = r.desk.preview('halve', 'BTC-USD')
  r.quotes['BTC-USD'] = { bid: 60000, ask: 60001 } // -1.6%
  const s = r.desk.confirm(p.id)
  assert.equal(s.status, 'failed')
  const r2 = rig()
  const p2 = r2.desk.preview('halve', 'BTC-USD')
  void r2.advance(PREVIEW_TTL_MS + 1)
  assert.equal(r2.desk.confirm(p2.id).status, 'failed')
})

test('exchange rejection: state failed, ledger untouched', async () => {
  const r = rig({ fail: 'INSUFFICIENT_FUND' })
  const p = r.desk.preview('close', 'BTC-USD')
  r.desk.confirm(p.id)
  await r.advance(UNDO_MS)
  const s = r.desk.get(p.id)!
  assert.equal(s.status, 'failed')
  if (s.status === 'failed') assert.equal(s.reason, 'INSUFFICIENT_FUND')
  close(r.ledger.qty('BTC-USD'), 0.02)
})

test('no position / no quote -> preview throws', () => {
  const r = rig()
  assert.throws(() => r.desk.preview('close', 'ETH-USD'))
})

test('baseSize trims trailing zeros', () => {
  assert.equal(baseSize(0.01), '0.01')
  assert.equal(baseSize(0.375), '0.375')
  assert.equal(baseSize(1), '1')
})

test('coinbaseOrders reads the success flag (sandbox response shape captured 2026-11-23)', async () => {
  const body = { success: true, success_response: { order_id: 'f898eaf4-6ffc-47be-a159-7ff292e5cdcf', product_id: 'BTC-USD', side: 'SELL', client_order_id: 'sandbox_success_order' } }
  let seen: any
  const ok = await coinbaseOrders('https://x', (async (url: string, init: any) => { seen = { url, init }; return new Response(JSON.stringify(body), { status: 200 }) }) as any)({
    client_order_id: 'a1', product_id: 'BTC-USD', side: 'SELL', order_configuration: { market_market_ioc: { base_size: '0.01' } },
  })
  assert.deepEqual(ok, { ok: true, orderId: 'f898eaf4-6ffc-47be-a159-7ff292e5cdcf' })
  assert.equal(seen.url, 'https://x/orders')
  assert.equal(JSON.parse(seen.init.body).client_order_id, 'a1')
  const bad = await coinbaseOrders('https://x', (async () => new Response(JSON.stringify({ success: false, error_response: { message: 'nope' } }), { status: 400 })) as any)({
    client_order_id: 'a2', product_id: 'BTC-USD', side: 'SELL', order_configuration: { market_market_ioc: { base_size: '0.01' } },
  })
  assert.deepEqual(bad, { ok: false, reason: 'nope' })
})
