// Risk page numbers, one held product at a time. The glasses only lay these out.
//
// Everything is "what happens to my money if ...", computed with the same conventions as the ledger
// (FIFO average entry, exit at bid for a long / ask for a short, taker fee on the exit):
//   atStop      total PnL of the position if the resting stop fires at its trigger (after the exit fee)
//   toStop      how much of today's value is lost between now and the stop (atStop - unrealized now)
//   atTake      same for the take-profit
//   swing24     money the position would have moved across the last 24 h high-low range
//   stopVsRange where the stop sits against the last 24 h: inside the range means the last day's
//               moves alone would have hit it
// The 24 h series is Coinbase's public 15-minute candles (no key), refreshed every few minutes.

import { REST, type Fetch } from './candles.ts'

export const SERIES_GRANULARITY_S = 900
export const SERIES_POINTS = 96 // 24 h of 15-minute candles
export const SERIES_REFRESH_MS = 5 * 60_000

export type Candle = { t: number; low: number; high: number; close: number }

/** Last 24 h of 15-minute candles, oldest first. */
export async function fetchSeries(product: string, now: number, fetchFn: Fetch = fetch as any): Promise<Candle[]> {
  const end = new Date(Math.floor(now / 60000) * 60000)
  const start = new Date(end.getTime() - SERIES_POINTS * SERIES_GRANULARITY_S * 1000)
  const url = `${REST}/products/${product}/candles?granularity=${SERIES_GRANULARITY_S}&start=${start.toISOString()}&end=${end.toISOString()}`
  const res = await fetchFn(url)
  if (!res.ok) throw new Error(`candles ${product} HTTP ${res.status}`)
  const rows: number[][] = await res.json()
  return toCandles(rows)
}

/** Coinbase rows are [time(s), low, high, open, close, volume], newest first. */
export function toCandles(rows: number[][]): Candle[] {
  return rows
    .map((r) => ({ t: r[0] * 1000, low: r[1], high: r[2], close: r[4] }))
    .filter((c) => c.low > 0 && c.high >= c.low && c.close > 0)
    .sort((a, b) => a.t - b.t)
    .slice(-SERIES_POINTS)
}

export type RiskInput = {
  product: string
  qty: number // signed
  avg: number
  bid: number
  ask: number
  price: number // last trade, for the chart
  stop: number | null
  take: number | null
  feeRate: number
  series: Candle[]
  now: number
}

export type RiskView = {
  product: string
  sym: string
  side: 'long' | 'short'
  qty: number
  avg: number
  exit: number // price you could exit at now
  upnl: number // after exit fee
  stop: number | null
  stopPct: number | null // stop vs exit price now, signed %
  atStop: number | null
  toStop: number | null
  take: number | null
  takePct: number | null
  atTake: number | null
  low24: number | null
  high24: number | null
  swing24: number | null
  /** 'inside' = the last 24 h range already touched the stop's level; 'beyond' = further than the 24 h extreme */
  stopVsRange: 'inside' | 'beyond' | null
  /** stop distance past the 24 h extreme, % of that extreme (positive = beyond) */
  stopBeyondPct: number | null
  /** 15-minute closes for the chart, oldest first, last point = the live price */
  closes: number[]
  seriesFrom: number | null
}

/** Total position PnL after the exit fee if the whole position is closed at `px`. */
export function pnlAt(qty: number, avg: number, px: number, feeRate: number): number {
  return qty * (px - avg) - Math.abs(qty) * px * feeRate
}

export function riskView(i: RiskInput): RiskView {
  const long = i.qty > 0
  const exit = long ? i.bid : i.ask
  const upnl = pnlAt(i.qty, i.avg, exit, i.feeRate)
  const pctFrom = (x: number) => ((x - exit) / exit) * 100
  const atStop = i.stop !== null ? pnlAt(i.qty, i.avg, i.stop, i.feeRate) : null
  const atTake = i.take !== null ? pnlAt(i.qty, i.avg, i.take, i.feeRate) : null
  const s = i.series
  const low24 = s.length ? Math.min(...s.map((c) => c.low), i.price) : null
  const high24 = s.length ? Math.max(...s.map((c) => c.high), i.price) : null
  let stopVsRange: RiskView['stopVsRange'] = null
  let stopBeyondPct: number | null = null
  if (i.stop !== null && low24 !== null && high24 !== null) {
    // the extreme on the stop's side: the 24 h low for a long, the high for a short
    const edge = long ? low24 : high24
    const beyond = long ? edge - i.stop : i.stop - edge
    stopVsRange = beyond > 0 ? 'beyond' : 'inside'
    stopBeyondPct = (beyond / edge) * 100
  }
  return {
    product: i.product,
    sym: i.product.replace(/-USD$/, ''),
    side: long ? 'long' : 'short',
    qty: i.qty,
    avg: i.avg,
    exit,
    upnl,
    stop: i.stop,
    stopPct: i.stop !== null ? pctFrom(i.stop) : null,
    atStop,
    toStop: atStop !== null ? atStop - upnl : null,
    take: i.take,
    takePct: i.take !== null ? pctFrom(i.take) : null,
    atTake,
    low24,
    high24,
    swing24: low24 !== null && high24 !== null ? Math.abs(i.qty) * (high24 - low24) : null,
    stopVsRange,
    stopBeyondPct,
    closes: s.length ? [...s.map((c) => c.close), i.price] : [],
    seriesFrom: s.length ? s[0].t : null,
  }
}

/** Keeps one 24 h series per product, refetched at most every SERIES_REFRESH_MS. */
export class SeriesCache {
  private data: Record<string, { at: number; candles: Candle[] }> = {}
  private inflight: Record<string, Promise<void> | undefined> = {}
  private fetchFn: Fetch
  constructor(fetchFn: Fetch = fetch as any) { this.fetchFn = fetchFn }
  get(product: string): Candle[] { return this.data[product]?.candles ?? [] }
  /** Starts a refresh if the cached series is missing or old; never throws (a failed fetch keeps the old series). */
  refresh(product: string, now: number): Promise<void> {
    const d = this.data[product]
    if (d && now - d.at < SERIES_REFRESH_MS) return Promise.resolve()
    if (this.inflight[product]) return this.inflight[product]!
    const p = fetchSeries(product, now, this.fetchFn)
      .then((candles) => { this.data[product] = { at: now, candles } })
      .catch((e) => console.error(`series ${product}: ${(e as Error).message}`))
      .finally(() => { this.inflight[product] = undefined })
    this.inflight[product] = p
    return p
  }
}
