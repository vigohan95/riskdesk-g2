// Pure layout for the 576x288 monochrome display. No SDK imports here so it is unit-testable in Node.
// Rules measured in the simulator before the hackathon (README "Display rules"):
// - line height 28 px; a text container needs h = lines x 28 + 2 x padding or a scrollbar appears
// - no text alignment and a proportional font -> right-align numbers by left-padding with
//   normal spaces and U+2009 thin spaces, widths taken from the firmware glyph table (pretext)
// - a 1 px border eats 2 px of that height (measured 11-23: h=44 + border showed a scrollbar)
// - one container per column (multi-line), not one per cell: the SDK allows 8 text containers
// - the footer is pinned at y=244 and is the event-capture layer
// - brightness (textColor 0-4) is the only emphasis on a monochrome panel

import { getTextWidth, pxTruncate } from '@evenrealities/pretext'

export const W = 576
export const H = 288
export const PAD = 8
export const LINE = 28
export const FOOTER_Y = 244
/** The PnL page always reserves this many position rows. */
export const MAX_ROWS = 3
export const boxH = (lines: number) => lines * LINE + 2 * PAD

export type Lang = 'en' | 'zh'
export type Text = { id: number; name: string; x: number; y: number; w: number; h: number; content: string; color: number; border?: boolean; capture?: boolean }
export type Page = { texts: Text[] }

// Mirrors server/src/state.ts (the app never computes money, it only formats it)
export type Row = { product: string; sym: string; price: number; chg24: number; qty: number; avg: number | null; upnl: number | null }
export type DeskState = {
  t: number
  feed: { status: 'connecting' | 'live' | 'stale'; ageMs: number | null }
  day: { pnl: number | null; pct: number | null }
  rows: Row[]
  openOrders: number
  alerts: number
}

const MINUS = '−'
const SP = ' '
const THIN = ' '

export function fmtNum(x: number, digits: number): string {
  const s = Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  return (x < 0 && Number(s.replace(/,/g, '')) !== 0 ? MINUS : '') + s
}
export const signed = (x: number, digits: number) => (x > 0 && fmtNum(x, digits) !== fmtNum(0, digits) ? '+' : '') + fmtNum(x, digits)
export function priceDigits(p: number): number {
  if (p >= 10000) return 0
  if (p >= 1000) return 1
  if (p >= 1) return 2
  return 4
}
export function fmtQty(q: number): string {
  const a = Math.abs(q)
  const d = a >= 100 ? 0 : a >= 1 ? 2 : 3
  return fmtNum(q, d)
}

/** Left-pad `s` with normal + thin spaces so its right edge lands at `w` px (error <= 1 px measured). */
export function rpad(s: string, w: number): string {
  // getAdvW is in 1/16 px and reports 0 for U+2009, so measure whole strings (kerning included).
  const sp = getTextWidth(SP)
  const th = getTextWidth(THIN)
  const gap = w - getTextWidth(s)
  if (gap <= 0) return s
  let best = s
  let err = gap
  for (let a = 0; a * sp <= gap + sp; a++) {
    for (const b of [Math.floor((gap - a * sp) / th), Math.ceil((gap - a * sp) / th)]) {
      if (b < 0) continue
      const cand = SP.repeat(a) + THIN.repeat(b) + s
      const e = Math.abs(w - getTextWidth(cand))
      if (e < err) { err = e; best = cand }
    }
  }
  return best
}
const col = (xs: string[], w: number) => xs.map((s) => rpad(s, w)).join('\n')

const L = {
  en: { today: 'Today', na: '—', live: 'feed ● live', stale: (s: number) => `feed ○ STALE ${s}s · prices frozen`, connecting: 'feed ○ connecting…', offline: 'backend offline · retrying', open: (n: number) => `${n} open`, alerts: (n: number) => `${n} alert${n === 1 ? '' : 's'}`, flat: 'flat', old: 'old', worst: 'Worst', afterFees: 'after fees, if closed now' },
  zh: { today: '今日', na: '—', live: '行情 ● 实时', stale: (s: number) => `行情 ○ 中断 ${s} 秒 · 价格已冻结`, connecting: '行情 ○ 连接中…', offline: '后端离线 · 重试中', open: (n: number) => `挂单 ${n}`, alerts: (n: number) => `提醒 ${n}`, flat: '空仓', old: '旧价', worst: '最差', afterFees: '扣费后，按现在平仓' },
}

/** PnL page: header, 4 columns (symbol / price / 24h / position), worst-position line, footer. */
export function pnlPage(s: DeskState | null, lang: Lang, offline = false): Page {
  const t = L[lang]
  // Geometry is fixed (MAX_ROWS lines) because textContainerUpgrade can change text but never size.
  const rows = (s?.rows ?? []).slice(0, MAX_ROWS)
  const live = s?.feed.status === 'live' && !offline
  const day = s?.day
  const head = day && day.pnl !== null
    ? `${t.today}  ${signed(day.pnl, 2)} USD${day.pct !== null ? `  (${signed(day.pct, 2)}%)` : ''}`
    : `${t.today}  ${t.na}`
  const sym = rows.map((r) => r.sym)
  const px = rows.map((r) => fmtNum(r.price, priceDigits(r.price)))
  // Brightness 1 vs 3 is only ~180 vs ~230 on the panel (measured), too subtle on its own:
  // when the feed is not live, the 24h column itself says the prices are old.
  const chg = rows.map((r) => (live ? `${signed(r.chg24, 1)}%` : t.old))
  const pos = rows.map((r) => (r.qty ? `${fmtQty(r.qty)}  ${signed(r.upnl ?? 0, 2)}` : t.flat))
  const held = rows.filter((r) => r.qty && r.upnl !== null)
  const worst = held.sort((a, b) => a.upnl! - b.upnl!)[0]
  const worstLine = worst
    ? `${t.worst}: ${worst.sym} ${signed(worst.upnl!, 2)} USD (${signed((worst.upnl! / (Math.abs(worst.qty) * worst.avg!)) * 100, 1)}%) · ${t.afterFees}`
    : ''
  let foot: string
  if (offline) foot = t.offline
  else if (!s || s.feed.status === 'connecting') foot = t.connecting
  else if (s.feed.status === 'stale') foot = t.stale(Math.round((s.feed.ageMs ?? 0) / 1000))
  else foot = `${t.open(s.openOrders)} · ${t.alerts(s.alerts)} · ${t.live}`
  const h = boxH(MAX_ROWS)
  const y = 52
  const dataColor = live ? 3 : 1 // dim everything that could be a frozen price
  const texts: Text[] = [
    { id: 1, name: 'head', x: 0, y: 0, w: W, h: boxH(1) + 2, content: head, color: live ? 4 : 2, border: true },
    { id: 2, name: 'sym', y, x: 0, w: 100, h, content: sym.join('\n'), color: dataColor },
    { id: 3, name: 'px', y, x: 100, w: 120, h, content: col(px, 120 - 2 * PAD), color: dataColor },
    { id: 4, name: 'chg', y, x: 220, w: 96, h, content: col(chg, 96 - 2 * PAD), color: dataColor },
    { id: 5, name: 'pos', y, x: 316, w: 260, h, content: col(pos, 260 - 2 * PAD), color: dataColor },
    { id: 6, name: 'worst', x: 0, y: y + h + 8, w: W, h: boxH(1), content: pxTruncate(worstLine, W - 2 * PAD), color: worst && worst.upnl! < 0 ? 4 : 2 },
    { id: 7, name: 'foot', x: 0, y: FOOTER_Y, w: W, h: boxH(1), content: foot, color: live ? 2 : 4, capture: true },
  ]
  return { texts }
}

/** Lines that would overflow their container (must be empty; used by tests and a dev assertion). */
export function overflows(p: Page): string[] {
  const bad: string[] = []
  for (const t of p.texts) {
    const lines = t.content.split('\n')
    if (lines.length * LINE + 2 * PAD + (t.border ? 2 : 0) > t.h) bad.push(`${t.name}: ${lines.length} lines in h=${t.h}`)
    for (const l of lines) if (getTextWidth(l) > t.w - 2 * PAD) bad.push(`${t.name}: "${l}" ${getTextWidth(l)}px > ${t.w - 2 * PAD}`)
    if (t.y + t.h > H) bad.push(`${t.name}: bottom ${t.y + t.h} > ${H}`)
  }
  return bad
}
