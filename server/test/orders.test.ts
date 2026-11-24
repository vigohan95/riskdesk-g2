import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ActionDesk, UNDO_MS, type OrderRequest } from '../src/actions.ts'
import { PaperLedger } from '../src/ledger.ts'
import { PaperOrderBook, triggerFor, crossed, type Resting } from '../src/orders.ts'

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)
const o = (x: Partial<Resting>): Resting => ({ id: 'o', product: 'BTC-USD', kind: 'stop', side: 'SELL', qty: 0.02, trigger: 60000, createdAt: 0, ...x })

test('triggerFor: stop below / take above for a long, mirrored for a short', () => {
  close(triggerFor('stop', 0.02, 61000), 59780)
  assert.equal(triggerFor('stop', 0.02, 64209.39), 62925.2) // 62,925.2022 -> floor to cents
  assert.equal(triggerFor('take', 0.75, 1837.73), 1892.87) // 1,892.8619 -> ceil to cents
  close(triggerFor('take', 0.02, 61000), 62830)
  close(triggerFor('stop', -1, 2000), 2040)
  close(triggerFor('take', -1, 2000), 1940)
})

test('crossed uses the exit side of the book: bid for a long, ask for a short', () => {
  // long stop at 60,000: bid 60,000 crosses, ask alone does not
  assert.equal(crossed(o({}), { bid: 60000.5, ask: 59999 }), false)
  assert.equal(crossed(o({}), { bid: 60000, ask: 60001 }), true)
  assert.equal(crossed(o({ kind: 'take', trigger: 62000 }), { bid: 62000, ask: 62001 }), true)
  assert.equal(crossed(o({ side: 'BUY', trigger: 2040 }), { bid: 2039.9, ask: 2040 }), true)
  assert.equal(crossed(o({ side: 'BUY', kind: 'take', trigger: 1940 }), { bid: 1939, ask: 1940.1 }), false)
})

test('book: one stop + one take per product, replace, OCO on trigger, reconcile clamps and drops', () => {
  const b = new PaperOrderBook()
  assert.equal(b.add(o({ id: 's1' })), undefined)
  assert.equal(b.add(o({ id: 's2', trigger: 59000 }))?.id, 's1') // replaced
  b.add(o({ id: 't1', kind: 'take', trigger: 63000 }))
  b.add(o({ id: 'e1', product: 'ETH-USD', qty: 0.75, trigger: 1600 }))
  assert.equal(b.size, 3)
  b.reconcile('BTC-USD', 0.01)
  assert.deepEqual(b.list().filter((x) => x.product === 'BTC-USD').map((x) => x.qty), [0.01, 0.01])
  assert.equal(b.take('BTC-USD', { bid: 60000, ask: 60001 }), null)
  assert.equal(b.take('BTC-USD', { bid: 58999, ask: 59000 })?.id, 's2')
  assert.deepEqual(b.list().map((x) => x.id), ['e1']) // take-profit went with it
  b.reconcile('ETH-USD', 0) // flat -> dropped
  assert.equal(b.size, 0)
})

function rig() {
  let now = Date.UTC(2026, 10, 23, 14)
  const timers: { at: number; fn: () => void; id: number }[] = []
  let tid = 0
  let n = 0
  const sent: OrderRequest[] = []
  const quotes: Record<string, { bid: number; ask: number }> = { 'BTC-USD': { bid: 61000, ask: 61001 }, 'ETH-USD': { bid: 1720, ask: 1720.1 } }
  const ledger = new PaperLedger()
  ledger.apply({ id: 'seed-b', product: 'BTC-USD', side: 'BUY', qty: 0.02, price: 60000, t: now - 3600_000 })
  ledger.apply({ id: 'seed-e', product: 'ETH-USD', side: 'BUY', qty: 0.75, price: 1690, t: now - 1800_000 })
  const states: string[] = []
  const desk = new ActionDesk({
    ledger,
    quote: (p) => quotes[p] ?? null,
    placeOrder: async (req) => { sent.push(req); return { ok: true, orderId: 'ord-' + sent.length } },
    onChange: (s) => states.push(`${s.p.kind}:${s.status}`),
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
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
    }
    now = end
  }
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) }
  const place = async (kind: 'stop' | 'take', product: string) => {
    const p = desk.preview(kind, product)
    desk.confirm(p.id)
    await advance(UNDO_MS)
    return p
  }
  return { desk, ledger, sent, quotes, states, advance, settle, place }
}

test('stop: preview prices the fill at the trigger, confirm + 5 s rests it in the book, nothing is sent', async () => {
  const r = rig()
  const p = r.desk.preview('stop', 'BTC-USD')
  close(p.trigger!, 59780)
  close(p.qty, 0.02)
  close(p.estNet, 0.02 * 59780 * (1 - 0.008))
  assert.equal(p.replaces, null)
  r.desk.confirm(p.id)
  await r.advance(UNDO_MS)
  assert.equal(r.desk.get(p.id)!.status, 'placed')
  assert.equal(r.sent.length, 0)
  assert.equal(r.desk.book.find('BTC-USD', 'stop')?.trigger, p.trigger)
  // a second stop shows what it replaces
  assert.equal(r.desk.preview('stop', 'BTC-USD').replaces, p.trigger)
})

test('stop fires once when the bid crosses: one market order, fill at the execution bid, take-profit cancelled', async () => {
  const r = rig()
  await r.place('stop', 'BTC-USD')
  await r.place('take', 'BTC-USD')
  assert.equal(r.desk.book.size, 2)
  r.quotes['BTC-USD'] = { bid: 59790, ask: 59791 }
  await r.desk.onQuote('BTC-USD')
  assert.equal(r.sent.length, 0) // not yet
  r.quotes['BTC-USD'] = { bid: 59700, ask: 59701 } // gapped through 59,780
  await Promise.all([r.desk.onQuote('BTC-USD'), r.desk.onQuote('BTC-USD')]) // two ticks in a row
  assert.equal(r.sent.length, 1)
  assert.deepEqual(r.sent[0].order_configuration, { market_market_ioc: { base_size: '0.02' } })
  assert.equal(r.ledger.qty('BTC-USD'), 0)
  assert.equal(r.ledger.fills.at(-1)!.price, 59700) // slippage shown honestly, not the trigger
  assert.equal(r.desk.book.size, 0)
  assert.ok(r.states.includes('stop:filled'))
})

test('a stale quote never triggers', async () => {
  const r = rig()
  await r.place('stop', 'BTC-USD')
  delete (r.quotes as any)['BTC-USD']
  await r.desk.onQuote('BTC-USD')
  assert.equal(r.sent.length, 0)
  assert.equal(r.desk.book.size, 1)
})

test('halving after a stop shrinks the stop; closing drops it', async () => {
  const r = rig()
  await r.place('stop', 'BTC-USD')
  const h = r.desk.preview('halve', 'BTC-USD')
  r.desk.confirm(h.id)
  await r.advance(UNDO_MS)
  close(r.desk.book.find('BTC-USD', 'stop')!.qty, 0.01)
  const c = r.desk.preview('close', 'BTC-USD')
  r.desk.confirm(c.id)
  await r.advance(UNDO_MS)
  assert.equal(r.desk.book.size, 0)
})

test('a close armed before a stop fires is refused instead of opening a short', async () => {
  const r = rig()
  await r.place('stop', 'BTC-USD')
  const c = r.desk.preview('close', 'BTC-USD')
  r.desk.confirm(c.id)
  r.quotes['BTC-USD'] = { bid: 59700, ask: 59701 }
  await r.desk.onQuote('BTC-USD') // stop fires during the undo window
  await r.advance(UNDO_MS)
  const s = r.desk.get(c.id)!
  assert.equal(s.status, 'failed')
  assert.equal(r.sent.length, 1)
  assert.equal(r.ledger.qty('BTC-USD'), 0)
})

test('cancel all: needs open orders, counts them, undo keeps them, confirm clears them', async () => {
  const r = rig()
  assert.throws(() => r.desk.preview('cancelAll', '*'), /no open orders/)
  await r.place('stop', 'BTC-USD')
  await r.place('take', 'ETH-USD')
  const p = r.desk.preview('cancelAll', '*')
  assert.equal(p.affected, 2)
  r.desk.confirm(p.id)
  r.desk.undo(p.id)
  await r.advance(UNDO_MS)
  assert.equal(r.desk.book.size, 2)
  const p2 = r.desk.preview('cancelAll', '*')
  r.desk.confirm(p2.id)
  await r.advance(UNDO_MS)
  const s = r.desk.get(p2.id)!
  assert.equal(s.status, 'placed')
  if (s.status === 'placed') assert.equal(s.affected, 2)
  assert.equal(r.desk.book.size, 0)
  assert.equal(r.sent.length, 0)
})

test('a stop confirmed after the market already crossed it fires right away', async () => {
  const r = rig()
  const p = r.desk.preview('take', 'ETH-USD') // 1720 x 1.03 = 1771.6
  r.desk.confirm(p.id)
  r.quotes['ETH-USD'] = { bid: 1736, ask: 1736.1 } // +0.9%: still inside the drift guard
  await r.advance(UNDO_MS - 1)
  r.quotes['ETH-USD'] = { bid: 1772, ask: 1772.1 }
  await r.advance(1)
  await r.settle()
  assert.equal(r.sent.length, 1)
  assert.equal(r.ledger.qty('ETH-USD'), 0)
})

test('bracket: one confirm prices both legs, 5 s later both rest in the book, nothing sent; take side fires and drops the stop', async () => {
  const r = rig()
  const p = r.desk.preview('bracket', 'BTC-USD', { trigger: 59000, take: 63000.004 })
  assert.equal(p.kind, 'bracket')
  assert.equal(p.trigger, 59000)
  assert.equal(p.take!.trigger, 63000) // rounded to the cent
  close(p.estNet, 0.02 * 59000 * (1 - 0.008)) // the money line is the stop leg
  close(p.take!.estNet, 0.02 * 63000 * (1 - 0.008))
  assert.equal(r.states.filter((s) => s.endsWith(':proposed')).length, 1) // pricing the legs proposes nothing else
  r.desk.confirm(p.id)
  await r.advance(UNDO_MS)
  assert.equal(r.desk.get(p.id)!.status, 'placed')
  assert.equal(r.sent.length, 0)
  assert.equal(r.desk.book.find('BTC-USD', 'stop')?.trigger, 59000)
  assert.equal(r.desk.book.find('BTC-USD', 'take')?.trigger, 63000)
  r.quotes['BTC-USD'] = { bid: 63010, ask: 63011 }
  await r.desk.onQuote('BTC-USD')
  assert.equal(r.sent.length, 1)
  assert.equal(r.ledger.qty('BTC-USD'), 0)
  assert.equal(r.desk.book.size, 0) // one cancels the other
})

test('bracket: a bad leg proposes nothing (never one leg); undo keeps the book empty; replaces shown per leg', async () => {
  const r = rig()
  assert.throws(() => r.desk.preview('bracket', 'BTC-USD', { trigger: 59000, take: 60000 }), /take 60000 would fire at once/)
  assert.throws(() => r.desk.preview('bracket', 'BTC-USD', { trigger: 61500, take: 63000 }), /stop 61500 would fire at once/)
  assert.equal(r.states.length, 0)
  const p = r.desk.preview('bracket', 'BTC-USD', { trigger: 59000, take: 63000 })
  r.desk.confirm(p.id)
  r.desk.undo(p.id)
  await r.advance(UNDO_MS)
  assert.equal(r.desk.book.size, 0)
  await r.place('stop', 'BTC-USD')
  await r.place('take', 'BTC-USD')
  const q = r.desk.preview('bracket', 'BTC-USD', { trigger: 59500, take: 62500 })
  close(q.replaces!, 59780)
  close(q.take!.replaces!, 62830)
})
