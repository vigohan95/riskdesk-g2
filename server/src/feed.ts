// Coinbase Advanced Trade market-data feed (public, no API key).
// - subscribes `ticker` + `heartbeats` on one connection
// - sequence_num is global per connection: a gap means we lost a message -> reconnect for a fresh snapshot
// - no heartbeat for STALE_MS -> status "stale" (the glasses must never show an old price as live)
// - pushes to listeners at most once per THROTTLE_MS, and only when a value changes at display precision

export const WS_URL = 'wss://advanced-trade-ws.coinbase.com'
export const STALE_MS = 3000
export const THROTTLE_MS = 1000

export type Tick = {
  product: string
  price: number
  bid: number
  ask: number
  chg24: number // percent
  low24: number
  high24: number
  t: number // ms epoch of the exchange timestamp
}
export type FeedStatus = 'connecting' | 'live' | 'stale'
export type FeedSnapshot = { status: FeedStatus; ticks: Record<string, Tick>; lastBeat: number }

/** Digits shown on the 576x288 display for a given price. */
export function displayDigits(price: number): number {
  if (price >= 10000) return 0
  if (price >= 1000) return 1
  if (price >= 1) return 2
  return 4
}
export function displayKey(t: Tick): string {
  const d = displayDigits(t.price)
  return `${t.price.toFixed(d)}|${t.chg24.toFixed(1)}`
}

/** Pure message reducer, unit-tested without a socket. */
export type Reduced = { ticks: Tick[]; beat: boolean; gap: boolean; seq: number | null }
export function reduceMessage(raw: string, lastSeq: number | null): Reduced {
  const out: Reduced = { ticks: [], beat: false, gap: false, seq: lastSeq }
  let msg: any
  try { msg = JSON.parse(raw) } catch { return out }
  const seq = typeof msg.sequence_num === 'number' ? msg.sequence_num : null
  if (seq !== null) {
    if (lastSeq !== null && seq <= lastSeq) return out // duplicate / late: ignore
    if (lastSeq !== null && seq > lastSeq + 1) out.gap = true
    out.seq = seq
  }
  const t = Date.parse(msg.timestamp ?? '') || Date.now()
  if (msg.channel === 'heartbeats') out.beat = true
  if (msg.channel === 'ticker') {
    for (const ev of msg.events ?? []) {
      for (const k of ev.tickers ?? []) {
        const tick: Tick = {
          product: k.product_id,
          price: Number(k.price),
          bid: Number(k.best_bid),
          ask: Number(k.best_ask),
          chg24: Number(k.price_percent_chg_24_h),
          low24: Number(k.low_24_h),
          high24: Number(k.high_24_h),
          t,
        }
        if (tick.product && Number.isFinite(tick.price) && tick.price > 0) out.ticks.push(tick)
      }
    }
  }
  return out
}

type WsLike = { send(s: string): void; close(): void; onopen: any; onmessage: any; onclose: any; onerror: any }
export type FeedOptions = {
  products: string[]
  url?: string
  connect?: (url: string) => WsLike
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
}

export class TickerFeed {
  status: FeedStatus = 'connecting'
  ticks: Record<string, Tick> = {}
  lastBeat = 0
  reconnects = 0
  private seq: number | null = null
  private ws: WsLike | null = null
  private pushed: Record<string, string> = {}
  private pushedStatus: FeedStatus | null = null
  private lastPush = 0
  private pending: unknown = null
  private listeners: ((s: FeedSnapshot) => void)[] = []
  private watchdog: unknown = null
  private stopped = false
  private o: Required<FeedOptions>

  constructor(opts: FeedOptions) {
    this.o = {
      url: WS_URL,
      connect: (u) => new WebSocket(u) as unknown as WsLike,
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as any),
      ...opts,
    }
  }

  onUpdate(fn: (s: FeedSnapshot) => void) { this.listeners.push(fn) }
  snapshot(): FeedSnapshot { return { status: this.status, ticks: { ...this.ticks }, lastBeat: this.lastBeat } }

  start() {
    this.stopped = false
    this.open()
    this.arm()
  }
  stop() {
    this.stopped = true
    this.ws?.close()
    if (this.watchdog) this.o.clearTimer(this.watchdog)
    if (this.pending) this.o.clearTimer(this.pending)
  }

  private open() {
    this.seq = null
    const ws = this.o.connect(this.o.url)
    this.ws = ws
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'subscribe', channel: 'ticker', product_ids: this.o.products }))
      ws.send(JSON.stringify({ type: 'subscribe', channel: 'heartbeats' }))
    }
    ws.onmessage = (ev: { data: unknown }) => this.handle(String(ev.data))
    ws.onclose = () => { if (!this.stopped && this.ws === ws) this.reconnect() }
    ws.onerror = () => {}
  }

  private reconnect() {
    this.reconnects++
    this.setStatus('stale')
    const old = this.ws
    this.ws = null
    try { old?.close() } catch {}
    this.o.setTimer(() => { if (!this.stopped) this.open() }, Math.min(5000, 500 * this.reconnects))
  }

  /** Exposed for tests: feed one raw frame. */
  handle(raw: string) {
    const r = reduceMessage(raw, this.seq)
    this.seq = r.seq
    if (r.gap) { this.reconnect(); return }
    if (r.beat) this.lastBeat = this.o.now()
    for (const t of r.ticks) this.ticks[t.product] = t
    if ((r.beat || r.ticks.length) && this.lastBeat && this.status !== 'live') {
      if (this.o.products.every((p) => this.ticks[p])) this.setStatus('live')
    }
    if (r.ticks.length) this.schedule()
  }

  /** Watchdog: called every 500 ms. */
  check() {
    if (this.status === 'live' && this.o.now() - this.lastBeat > STALE_MS) this.setStatus('stale')
  }
  private arm() {
    this.watchdog = this.o.setTimer(() => { this.check(); if (!this.stopped) this.arm() }, 500)
  }

  private setStatus(s: FeedStatus) {
    if (this.status === s) return
    this.status = s
    this.schedule()
  }

  private changed(): boolean {
    if (this.pushedStatus !== this.status) return true
    return Object.values(this.ticks).some((t) => this.pushed[t.product] !== displayKey(t))
  }

  private schedule() {
    if (this.pending) return
    const wait = Math.max(0, this.lastPush + THROTTLE_MS - this.o.now())
    this.pending = this.o.setTimer(() => { this.pending = null; this.flush() }, wait)
  }

  /** Exposed for tests. */
  flush() {
    if (!this.changed()) return
    this.lastPush = this.o.now()
    this.pushedStatus = this.status
    for (const t of Object.values(this.ticks)) this.pushed[t.product] = displayKey(t)
    const s = this.snapshot()
    for (const fn of this.listeners) fn(s)
  }
}
