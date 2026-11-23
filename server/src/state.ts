// What the glasses app receives. Kept small: the app only lays it out, it never computes money.

import type { FeedSnapshot } from './feed.ts'
import type { PaperLedger } from './ledger.ts'
import type { ActionState } from './actions.ts'

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
  /** The one action in flight (or just finished), or null. The glasses switch page on this. */
  action: ActionView | null
}

/** Everything the confirm / undo / result pages show, already computed by the server. */
export type ActionView = {
  id: string
  status: ActionState['status']
  kind: 'halve' | 'close'
  sym: string
  side: 'BUY' | 'SELL'
  qty: number
  estPrice: number
  estFee: number
  estNet: number
  exposureBefore: number
  exposureAfter: number
  remainMs: number | null // armed only: time left to undo
  fillPrice: number | null // filled only
  reason: string | null // failed only
  venue: 'sandbox' | 'production'
}

export function actionView(s: ActionState | null, now: number, venue: ActionView['venue'] = 'sandbox'): ActionView | null {
  if (!s) return null
  const p = s.p
  return {
    id: p.id,
    status: s.status,
    kind: p.kind,
    sym: p.product.replace(/-USD$/, ''),
    side: p.side,
    qty: p.qty,
    estPrice: p.estPrice,
    estFee: p.estFee,
    estNet: p.estNet,
    exposureBefore: p.exposureBefore,
    exposureAfter: p.exposureAfter,
    remainMs: s.status === 'armed' ? Math.max(0, s.fireAt - now) : null,
    fillPrice: s.status === 'filled' ? s.fill.price : null,
    reason: s.status === 'failed' ? s.reason : null,
    venue,
  }
}

export function buildState(
  snap: FeedSnapshot,
  ledger: PaperLedger,
  products: string[],
  dayStart: number,
  dayOpen: Record<string, number>,
  now: number,
  extra: { openOrders?: number; alerts?: number; action?: ActionState | null; venue?: ActionView['venue'] } = {},
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
    action: actionView(extra.action ?? null, now, extra.venue),
  }
}
