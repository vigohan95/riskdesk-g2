import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PaperLedger, utcDayStart } from '../src/ledger.ts'

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`)
const T0 = Date.UTC(2026, 10, 22, 12) // yesterday noon
const DAY = Date.UTC(2026, 10, 23)
const NOW = Date.UTC(2026, 10, 23, 8)

test('FIFO: sell closes the oldest lot first', () => {
  const L = new PaperLedger(0)
  L.apply({ id: 'a', product: 'BTC-USD', side: 'BUY', qty: 0.01, price: 50000, t: T0 })
  L.apply({ id: 'b', product: 'BTC-USD', side: 'BUY', qty: 0.01, price: 60000, t: T0 + 1 })
  L.apply({ id: 'c', product: 'BTC-USD', side: 'SELL', qty: 0.015, price: 62000, t: T0 + 2 })
  // closes 0.01 @50k (+120) and 0.005 @60k (+10)
  close(L.realized, 130)
  const p = L.position('BTC-USD', { bid: 62000, ask: 62001 })!
  close(p.qty, 0.005)
  close(p.avgPrice, 60000)
})

test('fees: 0.8% charged on each fill and on the estimated exit', () => {
  const L = new PaperLedger()
  const f = L.apply({ id: 'a', product: 'ETH-USD', side: 'BUY', qty: 1, price: 1000, t: T0 })
  close(f.fee!, 8)
  const p = L.position('ETH-USD', { bid: 1100, ask: 1101 })!
  close(p.unrealized, 100 - 8.8) // gross +100, exit fee 1100 x 0.8%
  close(L.equity({ 'ETH-USD': { bid: 1100, ask: 1101 } }), -1000 - 8 + 1100 - 8.8)
})

test('long marks at bid, short marks at ask', () => {
  const L = new PaperLedger(0)
  L.apply({ id: 'a', product: 'BTC-USD', side: 'BUY', qty: 1, price: 100, t: T0 })
  L.apply({ id: 'b', product: 'ETH-USD', side: 'SELL', qty: 2, price: 50, t: T0 })
  const q = { 'BTC-USD': { bid: 99, ask: 101 }, 'ETH-USD': { bid: 49, ask: 51 } }
  close(L.position('BTC-USD', q['BTC-USD'])!.unrealized, -1)
  close(L.position('ETH-USD', q['ETH-USD'])!.unrealized, -2)
})

test('flip: selling more than held opens a short at the fill price', () => {
  const L = new PaperLedger(0)
  L.apply({ id: 'a', product: 'BTC-USD', side: 'BUY', qty: 1, price: 100, t: T0 })
  L.apply({ id: 'b', product: 'BTC-USD', side: 'SELL', qty: 3, price: 110, t: T0 + 1 })
  close(L.realized, 10)
  const p = L.position('BTC-USD', { bid: 105, ask: 106 })!
  close(p.qty, -2)
  close(p.avgPrice, 110)
  close(p.unrealized, 2 * (110 - 106))
})

test('duplicate fill id is ignored (double-tap safety)', () => {
  const L = new PaperLedger(0)
  const f = { id: 'x', product: 'BTC-USD', side: 'BUY' as const, qty: 1, price: 100, t: T0 }
  L.apply(f)
  L.apply(f)
  close(L.qty('BTC-USD'), 1)
})

test('rejects bad and out-of-order fills', () => {
  const L = new PaperLedger(0)
  assert.throws(() => L.apply({ id: 'a', product: 'BTC-USD', side: 'BUY', qty: 0, price: 100, t: T0 }))
  L.apply({ id: 'b', product: 'BTC-USD', side: 'BUY', qty: 1, price: 100, t: T0 + 10 })
  assert.throws(() => L.apply({ id: 'c', product: 'BTC-USD', side: 'BUY', qty: 1, price: 100, t: T0 }))
})

test('day PnL: overnight position shows only the move since 00:00 UTC', () => {
  const L = new PaperLedger()
  L.apply({ id: 'a', product: 'BTC-USD', side: 'BUY', qty: 0.02, price: 58000, t: T0 })
  const q = { 'BTC-USD': { bid: 61200, ask: 61201 } }
  const d = L.dayPnl(q, DAY, { 'BTC-USD': 60000 })
  close(d.pnl, 0.02 * 61200 * (1 - 0.008) - 0.02 * 60000 * (1 - 0.008))
  close(d.base, 0.02 * 60000)
})

test('day PnL: a trade made today counts its entry fee', () => {
  const L = new PaperLedger()
  L.apply({ id: 'a', product: 'ETH-USD', side: 'BUY', qty: 1, price: 1700, t: NOW - 1000 })
  const d = L.dayPnl({ 'ETH-USD': { bid: 1700, ask: 1701 } }, DAY, {})
  close(d.pnl, -1700 * 0.008 * 2) // flat price: down both fees
  close(d.base, 1700)
})

test('day PnL: realized today is included, base excludes closed lots', () => {
  const L = new PaperLedger(0)
  L.apply({ id: 'a', product: 'BTC-USD', side: 'BUY', qty: 1, price: 100, t: T0 })
  L.apply({ id: 'b', product: 'BTC-USD', side: 'SELL', qty: 1, price: 120, t: NOW })
  const d = L.dayPnl({}, DAY, { 'BTC-USD': 110 })
  close(d.pnl, 10)
  close(d.base, 110)
})

test('utcDayStart', () => {
  assert.equal(utcDayStart(NOW), DAY)
})
