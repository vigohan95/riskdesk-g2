import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reduceMessage, TickerFeed, displayDigits, STALE_MS } from '../src/feed.ts'

// Frames captured from wss://advanced-trade-ws.coinbase.com on 2026-11-23 08:23 UTC (trimmed).
const snapBtc = (seq: number, price = '61227.05', chg = '2.88951472896642') =>
  JSON.stringify({ channel: 'ticker', timestamp: '2026-11-23T08:23:41.12238553Z', sequence_num: seq, events: [{ type: 'snapshot', tickers: [{ type: 'ticker', product_id: 'BTC-USD', price, volume_24_h: '9763.11488161', low_24_h: '59443.33', high_24_h: '61866.57', low_52_w: '55106', high_52_w: '97963.62', price_percent_chg_24_h: chg, best_bid: price, best_ask: '61227.06', best_bid_quantity: '1.01150882', best_ask_quantity: '0.00016402' }] }] })
const beat = (seq: number) =>
  JSON.stringify({ channel: 'heartbeats', timestamp: '2026-11-23T08:23:41.27328602Z', sequence_num: seq, events: [{ current_time: '2026-11-23 08:23:41.269939892 +0000 UTC m=+12965.287210667', heartbeat_counter: 12965 }] })
const subs = (seq: number) =>
  JSON.stringify({ channel: 'subscriptions', timestamp: '2026-11-23T08:23:41.12277273Z', sequence_num: seq, events: [{ subscriptions: { ticker: ['BTC-USD'] } }] })

test('reduceMessage parses ticker fields as numbers', () => {
  const r = reduceMessage(snapBtc(0), null)
  assert.equal(r.ticks.length, 1)
  const t = r.ticks[0]
  assert.equal(t.product, 'BTC-USD')
  assert.equal(t.price, 61227.05)
  assert.equal(t.ask, 61227.06)
  assert.ok(Math.abs(t.chg24 - 2.8895) < 1e-3)
  assert.equal(t.t, Date.parse('2026-11-23T08:23:41.122Z'))
})

test('reduceMessage: gaps flagged, duplicates ignored, garbage tolerated', () => {
  assert.equal(reduceMessage(snapBtc(5), 3).gap, true)
  assert.equal(reduceMessage(snapBtc(4), 3).gap, false)
  assert.equal(reduceMessage(snapBtc(3), 3).ticks.length, 0)
  assert.deepEqual(reduceMessage('not json', 1).ticks, [])
})

function rig() {
  let now = 1_000_000
  const timers: { at: number; fn: () => void; id: number }[] = []
  let id = 0
  const sockets: any[] = []
  const feed = new TickerFeed({
    products: ['BTC-USD'],
    now: () => now,
    setTimer: (fn, ms) => { timers.push({ at: now + ms, fn, id: ++id }); return id },
    clearTimer: (h) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1) },
    connect: () => {
      const s: any = { sent: [] as string[], send(x: string) { s.sent.push(x) }, close() { s.closed = true } }
      sockets.push(s)
      return s
    },
  })
  const advance = (ms: number) => {
    const end = now + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const t = timers[0]
      if (!t || t.at > end) break
      timers.shift()
      now = t.at
      t.fn()
    }
    now = end
  }
  return { feed, sockets, advance }
}

test('subscribes ticker + heartbeats on open', () => {
  const r = rig()
  r.feed.start()
  r.sockets[0].onopen()
  const sent = r.sockets[0].sent.map((s: string) => JSON.parse(s))
  assert.deepEqual(sent.map((m: any) => m.channel), ['ticker', 'heartbeats'])
  assert.deepEqual(sent[0].product_ids, ['BTC-USD'])
})

test('goes live after snapshot + heartbeat, stale after 3 s without heartbeat', () => {
  const r = rig()
  r.feed.start()
  r.sockets[0].onopen()
  const seen: string[] = []
  r.feed.onUpdate((s) => seen.push(s.status))
  r.feed.handle(subs(0))
  r.feed.handle(snapBtc(1))
  r.feed.handle(beat(2))
  r.advance(10)
  assert.equal(r.feed.status, 'live')
  r.advance(STALE_MS + 600)
  assert.equal(r.feed.status, 'stale')
  r.advance(1100)
  assert.deepEqual(seen, ['live', 'stale'])
})

test('throttle: at most one push per second, none if display value unchanged', () => {
  const r = rig()
  r.feed.start()
  r.sockets[0].onopen()
  let pushes = 0
  r.feed.onUpdate(() => pushes++)
  r.feed.handle(beat(0))
  r.feed.handle(snapBtc(1))
  r.advance(1)
  assert.equal(pushes, 1)
  // 20 updates inside one second -> exactly one more push
  for (let i = 0; i < 20; i++) {
    r.feed.handle(beat(2 + 2 * i))
    r.feed.handle(snapBtc(3 + 2 * i, String(61230 + i)))
  }
  r.advance(999)
  assert.equal(pushes, 2)
  // sub-precision move (BTC shows 0 decimals: 61249 -> 61249.2) -> no push
  r.feed.handle(beat(100))
  r.feed.handle(snapBtc(101, '61249.2'))
  r.advance(1500)
  assert.equal(pushes, 2)
})

test('sequence gap forces a reconnect and goes stale until fresh data', () => {
  const r = rig()
  r.feed.start()
  r.sockets[0].onopen()
  r.feed.handle(beat(0))
  r.feed.handle(snapBtc(1))
  r.advance(5)
  assert.equal(r.feed.status, 'live')
  r.feed.handle(snapBtc(7))
  assert.equal(r.feed.status, 'stale')
  assert.equal(r.sockets[0].closed, true)
  r.advance(600)
  assert.equal(r.sockets.length, 2)
  r.sockets[1].onopen()
  r.feed.handle(beat(0))
  r.feed.handle(snapBtc(1))
  r.advance(1100)
  assert.equal(r.feed.status, 'live')
})

test('display digits', () => {
  assert.equal(displayDigits(61227), 0)
  assert.equal(displayDigits(1718.6), 1)
  assert.equal(displayDigits(140.2), 2)
})
