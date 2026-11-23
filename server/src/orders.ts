// Paper resting orders: one stop-loss and one take-profit per position, watched against the live quote.
//
// Why paper and not exchange-native stops: the public Coinbase sandbox returns canned bodies and keeps no
// order book, so a native stop placed there could never trigger. RiskDesk keeps the book here and, when a
// trigger is crossed, sends one market IOC order (same path as a manual close) and books the fill.
//
// Trigger rules use the price you could actually exit at, the same one the PnL page marks with:
//   long  (protective SELL): stop when bid <= trigger, take-profit when bid >= trigger
//   short (protective BUY):  stop when ask >= trigger, take-profit when ask <= trigger
// One stop and one take per product: setting a new one replaces the old. When either fires the other is
// dropped (one-cancels-other). Quantity is re-clamped to the live position whenever the position changes,
// and orders on a product that went flat are dropped, so a resting order can never open a new position.

export type RestingKind = 'stop' | 'take'
export type Resting = {
  id: string
  product: string
  kind: RestingKind
  side: 'BUY' | 'SELL'
  qty: number
  trigger: number
  createdAt: number
}

/** Default distance of a new order from the current exit price (env STOP_PCT / TAKE_PCT override). */
export const STOP_PCT = 0.02
export const TAKE_PCT = 0.03

/** Trigger price for a new order on a position of signed size `held`, given the current exit price. */
export function triggerFor(kind: RestingKind, held: number, exitPrice: number, stopPct = STOP_PCT, takePct = TAKE_PCT): number {
  const long = held > 0
  const pct = kind === 'stop' ? stopPct : takePct
  // stop is on the losing side, take on the winning side
  const up = (kind === 'take') === long
  // Coinbase quote increment for BTC-USD / ETH-USD is 0.01: round to cents, away from the current price
  // so a rounded trigger is never closer than asked.
  const raw = exitPrice * (up ? 1 + pct : 1 - pct)
  return (up ? Math.ceil(raw * 100) : Math.floor(raw * 100)) / 100
}

export function crossed(o: Resting, q: { bid: number; ask: number }): boolean {
  if (o.side === 'SELL') return o.kind === 'stop' ? q.bid <= o.trigger : q.bid >= o.trigger
  return o.kind === 'stop' ? q.ask >= o.trigger : q.ask <= o.trigger
}

export class PaperOrderBook {
  private orders: Resting[] = []
  constructor(initial: Resting[] = []) { this.orders = initial.slice() }

  list(): Resting[] { return this.orders.slice() }
  get size(): number { return this.orders.length }
  find(product: string, kind: RestingKind): Resting | undefined { return this.orders.find((o) => o.product === product && o.kind === kind) }

  /** Adds `o`, replacing any order of the same product + kind. Returns the replaced one. */
  add(o: Resting): Resting | undefined {
    const old = this.find(o.product, o.kind)
    this.orders = this.orders.filter((x) => x !== old)
    this.orders.push(o)
    return old
  }

  cancelAll(): number {
    const n = this.orders.length
    this.orders = []
    return n
  }

  /** Re-fit orders on `product` to the live position (signed). Flat or flipped -> dropped. */
  reconcile(product: string, held: number): void {
    this.orders = this.orders.flatMap((o) => {
      if (o.product !== product) return [o]
      const wantSide = held > 0 ? 'SELL' : 'BUY'
      if (!held || o.side !== wantSide) return []
      return [{ ...o, qty: Math.min(o.qty, Math.abs(held)) }]
    })
  }

  /** Orders on `product` crossed by quote `q`. The first one crossed wins; the product's other orders are
   *  removed with it (one-cancels-other). Returns the order to execute, or null. */
  take(product: string, q: { bid: number; ask: number }): Resting | null {
    const hit = this.orders.find((o) => o.product === product && crossed(o, q))
    if (!hit) return null
    this.orders = this.orders.filter((o) => o.product !== product)
    return hit
  }
}
