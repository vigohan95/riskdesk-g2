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
  venue: 'sandbox' | 'production' | 'paper'
  refPrice: number // exit price seen at preview
  trigger: number | null // stop / take; bracket: the stop leg
  take: { trigger: number; estFee: number; estNet: number; replaces: number | null } | null // bracket: the take-profit leg
  replaces: number | null // stop / take: trigger of the order it replaces
  affected: number | null // cancelAll: orders to cancel (proposed) or cancelled (placed)
  auto: boolean // a resting order fired by itself
  heard: string | null // voice: transcript the proposal came from
  far: boolean // voice: spoken trigger > 20% from the live price
  /** filled / placed only: how the downside moved (see receipt()) */
  receipt: Receipt | null
}
/**
 * After-action receipt: the same downside number before and after the action, at the current exit price.
 *   metric 'stop'  : money lost between now and the stop if it fires (before = null: there was no stop, no floor)
 *   metric 'swing' : no stop on the position, so the yardstick is the last 24 h high-low range on its size
 * Spot has no liquidation, so "how much can this still cost me" is the number that changes.
 */
export type Receipt = { metric: 'stop' | 'swing'; stop: number | null; before: number | null; after: number }

/** Money lost from the exit price `exit` to `stop` on signed qty `q`, after the exit fee (negative = a loss). */
export function toStopLoss(q: number, stop: number, exit: number, feeRate: number): number {
  return q * (stop - exit) - Math.abs(q) * feeRate * (stop - exit)
}

export function receipt(
  s: ActionState | null,
  ctx: { bid: number; ask: number; stop: number | null; feeRate: number; series: Candle[] } | null,
): Receipt | null {
  if (!s || !ctx || (s.status !== 'filled' && s.status !== 'placed')) return null
  const p = s.p
  if (p.auto || p.kind === 'cancelAll' || p.kind === 'take') return null
  const q0 = p.exposureBefore
  if (!q0) return null
  const exit = q0 > 0 ? ctx.bid : ctx.ask
  if (!(exit > 0)) return null
  const loss = (q: number, stop: number) => (q ? Math.min(0, toStopLoss(q, stop, exit, ctx.feeRate)) : 0)
  if (p.kind === 'stop' || p.kind === 'bracket') {
    if (p.trigger === null) return null
    return { metric: 'stop', stop: p.trigger, before: p.replaces ? loss(q0, p.replaces) : null, after: loss(q0, p.trigger) }
  }
  // halve / close: the stop (if any) is unchanged, the size behind it shrank
  const q1 = p.exposureAfter
  if (ctx.stop !== null) return { metric: 'stop', stop: ctx.stop, before: loss(q0, ctx.stop), after: loss(q1, ctx.stop) }
  if (!ctx.series.length) return null
  const range = Math.max(...ctx.series.map((c) => c.high)) - Math.min(...ctx.series.map((c) => c.low))
  return { metric: 'swing', stop: null, before: Math.abs(q0) * range, after: Math.abs(q1) * range }
}

export function actionView(s: ActionState | null, now: number, venue: ActionView['venue'] = 'sandbox', rc: Receipt | null = null): ActionView | null {
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
    take: p.take,
    replaces: p.replaces,
    affected: s.status === 'placed' && p.kind === 'cancelAll' ? s.affected : p.affected,
    auto: p.auto,
    heard: p.heard,
    far: p.far,
    receipt: rc,
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
  function actionReceipt(): Receipt | null {
    const a = extra.action ?? null
    if (!a || a.p.product === '*' || snap.status !== 'live') return null
    const q = quotes[a.p.product]
    if (!q) return null
    return receipt(a, { ...q, stop: extra.book?.find(a.p.product, 'stop')?.trigger ?? null, feeRate: ledger.feeRate, series: extra.series?.(a.p.product) ?? [] })
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
    action: actionView(extra.action ?? null, now, extra.venue, actionReceipt()),
    voice: extra.voice ?? null,
    notice: extra.notice ?? null,
    risk,
  }
}
