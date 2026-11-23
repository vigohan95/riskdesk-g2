// Local paper ledger. Every number on the glasses comes from here x the live Coinbase quote;
// the Coinbase sandbox only proves the order request/response shape (it returns canned data).
//
// Conventions (see README "How PnL is computed"):
// - FIFO lots, signed quantity (long > 0, short < 0)
// - fee = |qty| x price x feeRate on every fill (default 0.8%, Coinbase's lowest-volume taker tier)
// - open positions are marked at the price you could exit at now: long -> best bid, short -> best ask,
//   minus the estimated exit fee. So PnL shown is always "after fees, if I closed now".
// - day PnL = equity now - equity at 00:00 UTC (positions held then, marked at the 00:00 UTC price).
//   No deposits exist in a paper ledger, so equity change == trading PnL.

export const DEFAULT_FEE_RATE = 0.008

export type Side = 'BUY' | 'SELL'
export type Fill = { id: string; product: string; side: Side; qty: number; price: number; t: number; fee?: number }
export type Lot = { qty: number; price: number; t: number }
export type Quote = { bid: number; ask: number }
export type PositionView = {
  product: string
  qty: number
  avgPrice: number
  cost: number // |qty| x avg entry
  exitPrice: number
  unrealized: number // after estimated exit fee
}

const EPS = 1e-12

export class PaperLedger {
  readonly fills: Fill[] = []
  private lots: Record<string, Lot[]> = {}
  cash = 0
  realized = 0 // gross realized PnL (before fees)
  feesPaid = 0

  readonly feeRate: number
  constructor(feeRate = DEFAULT_FEE_RATE) { this.feeRate = feeRate }

  apply(f: Fill): Fill {
    if (!(f.qty > 0) || !(f.price > 0)) throw new Error(`bad fill ${f.id}: qty and price must be > 0`)
    if (this.fills.length && f.t < this.fills[this.fills.length - 1].t) throw new Error(`fill ${f.id} is out of order`)
    if (this.fills.some((x) => x.id === f.id)) return this.fills.find((x) => x.id === f.id)! // idempotent
    const fee = f.fee ?? round(f.qty * f.price * this.feeRate, 8)
    const fill = { ...f, fee }
    this.fills.push(fill)
    const signed = f.side === 'BUY' ? f.qty : -f.qty
    this.cash -= signed * f.price + fee
    this.feesPaid += fee
    const lots = (this.lots[f.product] ??= [])
    let left = signed
    while (Math.abs(left) > EPS && lots.length && Math.sign(lots[0].qty) !== Math.sign(left)) {
      const lot = lots[0]
      const close = Math.min(Math.abs(left), Math.abs(lot.qty)) * Math.sign(lot.qty) // signed qty of the lot being closed
      this.realized += close * (f.price - lot.price)
      lot.qty -= close
      left += close
      if (Math.abs(lot.qty) <= EPS) lots.shift()
    }
    if (Math.abs(left) > EPS) lots.push({ qty: left, price: f.price, t: f.t })
    return fill
  }

  products(): string[] { return Object.keys(this.lots).filter((p) => this.qty(p) !== 0) }
  qty(product: string): number { return round((this.lots[product] ?? []).reduce((s, l) => s + l.qty, 0), 10) }

  position(product: string, q: Quote): PositionView | null {
    const lots = this.lots[product] ?? []
    const qty = this.qty(product)
    if (!qty) return null
    const cost = lots.reduce((s, l) => s + Math.abs(l.qty) * l.price, 0)
    const avgPrice = cost / Math.abs(qty)
    const exitPrice = qty > 0 ? q.bid : q.ask
    const gross = qty * (exitPrice - avgPrice)
    const exitFee = Math.abs(qty) * exitPrice * this.feeRate
    return { product, qty, avgPrice, cost, exitPrice, unrealized: gross - exitFee }
  }

  /** Mark-to-exit equity (cash + liquidation value of open positions after exit fees). */
  equity(quotes: Record<string, Quote>): number {
    let eq = this.cash
    for (const p of this.products()) {
      const q = quotes[p]
      if (!q) throw new Error(`no quote for ${p}`)
      const qty = this.qty(p)
      const exit = qty > 0 ? q.bid : q.ask
      eq += qty * exit - Math.abs(qty) * exit * this.feeRate
    }
    return eq
  }

  /**
   * Day PnL since `dayStart` (ms, normally 00:00 UTC).
   * `dayOpen[product]` = the traded price at dayStart (from the public 1-minute candle).
   * Opening equity is marked at that price minus the same exit fee, so a position you merely held
   * overnight shows only today's move, not yesterday's fees.
   */
  dayPnl(quotes: Record<string, Quote>, dayStart: number, dayOpen: Record<string, number>): { pnl: number; base: number; pct: number | null } {
    const before = new PaperLedger(this.feeRate)
    for (const f of this.fills) if (f.t < dayStart) before.apply(f)
    let startEq = before.cash
    let base = 0
    for (const p of before.products()) {
      const px = dayOpen[p]
      if (!(px > 0)) throw new Error(`no day-open price for ${p}`)
      const qty = before.qty(p)
      startEq += qty * px - Math.abs(qty) * px * this.feeRate
      base += Math.abs(qty) * px
    }
    // Percent base: what was at risk at the open, plus cost of lots opened today and still held.
    for (const p of this.products()) {
      for (const l of this.lots[p] ?? []) if (l.t >= dayStart) base += Math.abs(l.qty) * l.price
    }
    const pnl = this.equity(quotes) - startEq
    return { pnl, base, pct: base > 0 ? (pnl / base) * 100 : null }
  }
}

export function round(x: number, d: number): number {
  const k = 10 ** d
  return Math.round(x * k) / k
}

export function utcDayStart(t: number): number {
  const d = new Date(t)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}
