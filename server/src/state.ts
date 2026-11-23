// What the glasses app receives. Kept small: the app only lays it out, it never computes money.

import type { FeedSnapshot } from './feed.ts'
import type { PaperLedger } from './ledger.ts'
import type { ActionState, ActionKind } from './actions.ts'
import type { PaperOrderBook } from './orders.ts'
import { riskView, type Candle, type RiskView } from './risk.ts'

export type Row = {
  product: string
  sym: string
  price: number
  chg24: number
  qty: number
  avg: number | null
  upnl: number | null // after estimated exit fee
  stop: number | null // resting paper stop-loss trigger
  take: number | null // resting paper take-profit trigger
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
  /** Hold-to-talk in progress: the glasses show a listening / transcribing page. */
  voice: VoiceView | null
  /** A short message that is not an order: alert set or hit, or why a voice command did nothing. */
  notice: Notice | null
  /** One entry per held product (in PRODUCTS order): the risk page. */
  risk: RiskView[]
}
export type VoiceView = { status: 'listening' | 'thinking'; lang: 'en' | 'zh'; seconds: number }
/** undo: id of the alert this notice just set; a tap on the page removes it again. */
export type Notice = { id: string; en: string; zh: string; heard: string | null; undo: string | null }

/** Everything the confirm / undo / result pages show, already computed by the server. */
export type ActionView = {
  id: string
  status: ActionState['status']
  kind: ActionKind
  sym: string // '' for cancelAll
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
  refPrice: number // exit price seen at preview
  trigger: number | null // stop / take
  replaces: number | null // stop / take: trigger of the order it replaces
  affected: number | null // cancelAll: orders to cancel (proposed) or cancelled (placed)
  auto: boolean // a resting order fired by itself
  heard: string | null // voice: transcript the proposal came from
  far: boolean // voice: spoken trigger > 20% from the live price
}

export function actionView(s: ActionState | null, now: number, venue: ActionView['venue'] = 'sandbox'): ActionView | null {
  if (!s) return null
  const p = s.p
  return {
    id: p.id,
    status: s.status,
    kind: p.kind,
    sym: p.product === '*' ? '' : p.product.replace(/-USD$/, ''),
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
    refPrice: p.refPrice,
    trigger: p.trigger,
    replaces: p.replaces,
    affected: s.status === 'placed' && p.kind === 'cancelAll' ? s.affected : p.affected,
    auto: p.auto,
    heard: p.heard,
    far: p.far,
  }
}

export function buildState(
  snap: FeedSnapshot,
  ledger: PaperLedger,
  products: string[],
  dayStart: number,
  dayOpen: Record<string, number>,
  now: number,
  extra: { book?: PaperOrderBook; alerts?: number; action?: ActionState | null; venue?: ActionView['venue']; voice?: VoiceView | null; notice?: Notice | null; series?: (product: string) => Candle[] } = {},
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
      stop: extra.book?.find(p, 'stop')?.trigger ?? null,
      take: extra.book?.find(p, 'take')?.trigger ?? null,
    })
  }
  const risk: RiskView[] = []
  if (snap.status === 'live') {
    // Risk numbers are only shown on a live feed: a frozen price would make every distance wrong.
    for (const r of rows) {
      const tk = snap.ticks[r.product]
      if (!r.qty || r.avg === null || !tk) continue
      risk.push(riskView({
        product: r.product, qty: r.qty, avg: r.avg, bid: tk.bid, ask: tk.ask, price: tk.price,
        stop: r.stop, take: r.take, feeRate: ledger.feeRate, series: extra.series?.(r.product) ?? [], now,
      }))
    }
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
    openOrders: extra.book?.size ?? 0,
    alerts: extra.alerts ?? 0,
    action: actionView(extra.action ?? null, now, extra.venue),
    voice: extra.voice ?? null,
    notice: extra.notice ?? null,
    risk,
  }
}
