// Paper price alerts ("BTC 跌破 6 万提醒我"). They move no money: when the live price crosses one,
// it is removed and the glasses show a result page for a few seconds. One alert per product and
// direction; a new one replaces the old (same rule as stop / take-profit).

export type Alert = { id: string; product: string; dir: 'below' | 'above'; price: number; createdAt: number }

export class PriceAlerts {
  private items: Alert[]
  constructor(initial: Alert[] = []) { this.items = [...initial] }
  list(): Alert[] { return [...this.items] }
  get size(): number { return this.items.length }
  /** Returns the alert it replaced, if any. */
  set(a: Alert): Alert | null {
    const i = this.items.findIndex((x) => x.product === a.product && x.dir === a.dir)
    const old = i >= 0 ? this.items[i] : null
    if (i >= 0) this.items.splice(i, 1)
    this.items.push(a)
    return old
  }
  /** Alerts crossed by this price; they are removed. */
  check(product: string, price: number): Alert[] {
    const hit = this.items.filter((a) => a.product === product && (a.dir === 'below' ? price <= a.price : price >= a.price))
    if (hit.length) this.items = this.items.filter((a) => !hit.includes(a))
    return hit
  }
  remove(id: string): boolean {
    const n = this.items.length
    this.items = this.items.filter((a) => a.id !== id)
    return this.items.length < n
  }
  clear(): number { const n = this.items.length; this.items = []; return n }
}
