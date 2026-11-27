import { test } from 'node:test'
import assert from 'node:assert/strict'
import { riskView, pnlAt, toCandles, SeriesCache, SERIES_POINTS, type Candle } from '../src/risk.ts'
import { PaperLedger } from '../src/ledger.ts'

const close = (a: number | null, b: number, eps = 1e-6) => assert.ok(a !== null && Math.abs(a - b) < eps, `${a} != ${b}`)
const NOW = Date.UTC(2026, 10, 23, 23)
const series = (lows: number[], highs: number[]): Candle[] =>
  lows.map((l, k) => ({ t: NOW - (lows.length - k) * 900_000, low: l, high: highs[k], close: (l + highs[k]) / 2 }))

test('pnlAt matches the ledger mark (same fee convention)', () => {
  const L = new PaperLedger(0.008)
  L.apply({ id: 'a', product: 'BTC-USD', side: 'BUY', qty: 0.02, price: 60000, t: 1 })
  const pos = L.position('BTC-USD', { bid: 61000, ask: 61010 })!
  close(pnlAt(0.02, pos.avgPrice, 61000, 0.008), pos.unrealized)
})

test('long with a stop: money at stop, money lost from here, stop beyond the 24 h low', () => {
  const v = riskView({
    product: 'BTC-USD', qty: 0.02, avg: 60000, bid: 61000, ask: 61010, price: 61005,
    stop: 59780, take: 62830, feeRate: 0.008, series: series([60500, 60200], [61200, 61500]), now: NOW,
  })
  assert.equal(v.side, 'long')
  close(v.exit, 61000)
  close(v.upnl, 0.02 * 1000 - 0.02 * 61000 * 0.008)
  close(v.atStop, 0.02 * (59780 - 60000) - 0.02 * 59780 * 0.008)
  close(v.toStop, v.atStop! - v.upnl)
  assert.ok(v.toStop! < 0)
  close(v.stopPct, ((59780 - 61000) / 61000) * 100)
  close(v.atTake, 0.02 * 2830 - 0.02 * 62830 * 0.008)
  close(v.low24, 60200)
  close(v.high24, 61500)
  close(v.swing24, 0.02 * 1300)
  assert.equal(v.stopVsRange, 'beyond')
  close(v.stopBeyondPct, ((60200 - 59780) / 60200) * 100)
  assert.deepEqual(v.closes, [60850, 60850, 61005])
})

test('long stop inside the 24 h range is flagged (the last day alone would have hit it)', () => {
  const v = riskView({
    product: 'ETH-USD', qty: 0.75, avg: 1600, bid: 1650, ask: 1651, price: 1650.5,
    stop: 1617, take: null, feeRate: 0.008, series: series([1600], [1660]), now: NOW,
  })
  assert.equal(v.stopVsRange, 'inside')
  assert.ok(v.stopBeyondPct! < 0)
  assert.equal(v.atTake, null)
  assert.equal(v.takePct, null)
})

test('short: exit at the ask, stop compared with the 24 h high', () => {
  const v = riskView({
    product: 'BTC-USD', qty: -0.01, avg: 62000, bid: 61000, ask: 61010, price: 61005,
    stop: 62230, take: null, feeRate: 0, series: series([60800], [62100]), now: NOW,
  })
  assert.equal(v.side, 'short')
  close(v.exit, 61010)
  close(v.upnl, 9.9)
  close(v.atStop, -2.3)
  assert.equal(v.stopVsRange, 'beyond')
})

test('no stop: stop fields are null, swing still shown; no series: no chart, no range', () => {
  const a = riskView({ product: 'BTC-USD', qty: 0.02, avg: 60000, bid: 61000, ask: 61010, price: 61005, stop: null, take: null, feeRate: 0.008, series: series([60000], [62000]), now: NOW })
  assert.equal(a.stop, null); assert.equal(a.atStop, null); assert.equal(a.toStop, null); assert.equal(a.stopVsRange, null)
  close(a.swing24, 40)
  const b = riskView({ product: 'BTC-USD', qty: 0.02, avg: 60000, bid: 61000, ask: 61010, price: 61005, stop: 59000, take: null, feeRate: 0.008, series: [], now: NOW })
  assert.equal(b.low24, null); assert.equal(b.swing24, null); assert.equal(b.stopVsRange, null)
  assert.deepEqual(b.closes, [])
})

test('toCandles: newest-first rows -> oldest first, bad rows dropped, capped at 24 h', () => {
  const rows = Array.from({ length: 120 }, (_, k) => [1000 - k, 10, 12, 11, 11.5, 1])
  rows.push([5, 0, 1, 1, 1, 1])
  const c = toCandles(rows)
  assert.equal(c.length, SERIES_POINTS)
  assert.ok(c[0].t < c[c.length - 1].t)
  assert.equal(c[c.length - 1].t, 1000_000)
})

test('SeriesCache: one fetch per refresh window, failure keeps the old series', async () => {
  let calls = 0
  let fail = false
  const fetchFn = async () => { calls++; if (fail) return { ok: false, status: 503, json: async () => [] }; return { ok: true, status: 200, json: async () => [[100, 1, 2, 1.5, 1.6, 1]] } }
  const c = new SeriesCache(fetchFn)
  await Promise.all([c.refresh('BTC-USD', 0), c.refresh('BTC-USD', 0)])
  assert.equal(calls, 1)
  await c.refresh('BTC-USD', 60_000)
  assert.equal(calls, 1)
  fail = true
  await c.refresh('BTC-USD', 10 * 60_000)
  assert.equal(calls, 2)
  assert.equal(c.get('BTC-USD').length, 1)
})

test('after-action receipt: halve under a stop halves the loss-to-stop; a new stop turns no floor into a number', async () => {
  const { receipt, toStopLoss } = await import('../src/state.ts')
  const base = { id: 'x', createdAt: 0, side: 'SELL' as const, product: 'ETH-USD', estPrice: 1700, estFee: 0, estNet: 0, refPrice: 1700, replaces: null, affected: null, auto: false, heard: null, far: false, take: null }
  const ctx = { bid: 1700, ask: 1701, stop: 1650, feeRate: 0.006, series: [] as any[] }
  // long 0.75 ETH, stop 1650, exit at bid 1700: lose 0.75*50 minus the smaller exit fee at the lower price
  const full = toStopLoss(0.75, 1650, 1700, 0.006)
  assert.ok(Math.abs(full - (0.75 * -50 + 0.75 * 0.006 * 50)) < 1e-9)
  const halve = receipt({ status: 'filled', p: { ...base, kind: 'halve', qty: 0.375, exposureBefore: 0.75, exposureAfter: 0.375, trigger: null } as any, fill: {} as any, orderId: 'o' }, ctx)!
  assert.equal(halve.metric, 'stop')
  assert.ok(Math.abs(halve.after - halve.before! / 2) < 1e-9)
  const stop = receipt({ status: 'placed', p: { ...base, kind: 'stop', qty: 0.75, exposureBefore: 0.75, exposureAfter: 0, trigger: 1666 } as any, affected: 1 }, { ...ctx, stop: 1666 })!
  assert.equal(stop.before, null)
  assert.ok(stop.after < 0)
  const moved = receipt({ status: 'placed', p: { ...base, kind: 'stop', qty: 0.75, exposureBefore: 0.75, exposureAfter: 0, trigger: 1680, replaces: 1650 } as any, affected: 1 }, { ...ctx, stop: 1680 })!
  assert.ok(moved.before! < moved.after, 'tighter stop = smaller loss')
  // no stop: 24 h range on the size
  const sw = receipt({ status: 'filled', p: { ...base, kind: 'halve', qty: 0.375, exposureBefore: 0.75, exposureAfter: 0.375, trigger: null } as any, fill: {} as any, orderId: 'o' },
    { ...ctx, stop: null, series: [{ t: 0, low: 1600, high: 1720, close: 1700 }] })!
  assert.deepEqual([sw.metric, sw.before, sw.after], ['swing', 90, 45])
  // a resting stop that fired by itself, a take-profit, an unfinished action: no receipt
  assert.equal(receipt({ status: 'filled', p: { ...base, kind: 'stop', auto: true, qty: 0.75, exposureBefore: 0.75, exposureAfter: 0, trigger: 1650 } as any, fill: {} as any, orderId: 'o' }, ctx), null)
  assert.equal(receipt({ status: 'placed', p: { ...base, kind: 'take', qty: 0.75, exposureBefore: 0.75, exposureAfter: 0, trigger: 1800 } as any, affected: 1 }, ctx), null)
  assert.equal(receipt({ status: 'armed', p: { ...base, kind: 'halve', qty: 0.375, exposureBefore: 0.75, exposureAfter: 0.375, trigger: null } as any, fireAt: 1 }, ctx), null)
})
