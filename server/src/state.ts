// What the glasses app receives. Kept small: the app only lays it out, it never computes money.

import type { FeedSnapshot } from './feed.ts'
import type { PaperLedger } from './ledger.ts'

export type Row = {
  product: string
  sym: string
  price: number
  chg24: number
  qty: number
  avg: number | null
  upnl: number | null // after estimated exit fee
}
export type DeskState = {
  t: number
  feed: { status: 'connecting' | 'live' | 'stale'; ageMs: number | null }
  day: { pnl: number | null; pct: number | null }
  rows: Row[]
  openOrders: number
  alerts: number
}

export function buildState(
  snap: FeedSnapshot,
  ledger: PaperLedger,
  products: string[],
  dayStart: number,
  dayOpen: Record<string, number>,
  now: number,
  extra: { openOrders?: number; alerts?: number } = {},
): DeskState {
  const quotes: Record<string, { bid: number; ask: number }> = {}
  for (const [p, t] of Object.entries(snap.ticks)) quotes[p] = { bid: t.bid, ask: t.ask }
  const rows: Row[] = []
  for (const p of products) {
    const tk = snap.ticks[p]
    if (!tk) continue
    const pos = ledger.position(p, quotes[p])
    rows.push({
      product: p,
      sym: p.replace(/-USD$/, ''),
      price: tk.price,
      chg24: tk.chg24,
      qty: pos?.qty ?? 0,
      avg: pos?.avgPrice ?? null,
      upnl: pos?.unrealized ?? null,
    })
  }
  let day: DeskState['day'] = { pnl: null, pct: null }
  const held = ledger.products()
  // Only compute day PnL when every held product has a live quote; otherwise show nothing rather than a wrong number.
  if (held.every((p) => quotes[p]) && Object.keys(dayOpen).length) {
    try {
      const d = ledger.dayPnl(quotes, dayStart, dayOpen)
      day = { pnl: d.pnl, pct: d.pct }
    } catch { /* missing day-open price: leave null */ }
  }
  return {
    t: now,
    feed: { status: snap.status, ageMs: snap.lastBeat ? now - snap.lastBeat : null },
    day,
    rows,
    openOrders: extra.openOrders ?? 0,
    alerts: extra.alerts ?? 0,
  }
}
