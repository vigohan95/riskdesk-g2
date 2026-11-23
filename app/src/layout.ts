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
  action: ActionView | null
}
export type ActionView = {
  id: string
  status: 'proposed' | 'armed' | 'undone' | 'sending' | 'filled' | 'failed'
  kind: 'halve' | 'close'
  sym: string
  side: 'BUY' | 'SELL'
  qty: number
  estPrice: number
  estFee: number
  estNet: number
  exposureBefore: number
  exposureAfter: number
  remainMs: number | null
  fillPrice: number | null
  reason: string | null
  venue: 'sandbox' | 'production'
}
export type PageKind = 'pnl' | 'confirm' | 'undo' | 'result'
export function pageKind(s: DeskState | null): PageKind {
  switch (s?.action?.status) {
    case 'proposed': return 'confirm'
    case 'armed': case 'sending': return 'undo'
    case 'filled': case 'undone': case 'failed': return 'result'
    default: return 'pnl'
  }
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

// ---------------------------------------------------------------------------------------------
// Action pages. One question per page, the money number is the brightest line, and the only
// event-capture container is the footer, which always says what a tap does on this page.

const A = {
  en: {
    title: (v: ActionView) => `${v.kind === 'close' ? 'Close' : 'Halve'} ${v.sym}?`,
    order: (v: ActionView) => `${v.side === 'SELL' ? 'Sell' : 'Buy'} ${fmtQty(v.qty)} ${v.sym} at ≈ ${fmtNum(v.estPrice, priceDigits(v.estPrice))} (${v.side === 'SELL' ? 'bid' : 'ask'})`,
    money: (v: ActionView) => `${v.estNet >= 0 ? 'You get' : 'You pay'} ≈ ${fmtNum(Math.abs(v.estNet), 2)} USD`,
    fee: (v: ActionView) => `fee ${fmtNum(v.estFee, 2)}`,
    pos: (v: ActionView) => `Position ${fmtQty(v.exposureBefore)} → ${fmtQty(v.exposureAfter)} ${v.sym}`,
    confirmFoot: 'tap = confirm (5 s to undo) · double-tap = back',
    armed: (v: ActionView, s: number) => `${v.side === 'SELL' ? 'Selling' : 'Buying'} ${fmtQty(v.qty)} ${v.sym} in ${s} s`,
    sending: (v: ActionView) => `Sending ${v.side === 'SELL' ? 'sell' : 'buy'} ${fmtQty(v.qty)} ${v.sym}…`,
    undoFoot: 'tap = UNDO · nothing is sent until the dots run out',
    sendingFoot: 'sent, waiting for the exchange',
    filled: (v: ActionView) => `Done: ${v.side === 'SELL' ? 'sold' : 'bought'} ${fmtQty(v.qty)} ${v.sym} at ${fmtNum(v.fillPrice!, priceDigits(v.fillPrice!))}`,
    undone: 'Undone. Nothing was sent.',
    failed: 'Not executed. Nothing changed.',
    resultFoot: 'tap = back to positions',
    sandbox: 'Coinbase sandbox order, booked in the paper ledger',
  },
  zh: {
    title: (v: ActionView) => `${v.sym} ${v.kind === 'close' ? '全部平仓' : '减半'}？`,
    order: (v: ActionView) => `${v.side === 'SELL' ? '卖出' : '买入'} ${fmtQty(v.qty)} ${v.sym}，约 ${fmtNum(v.estPrice, priceDigits(v.estPrice))}（${v.side === 'SELL' ? '买一价' : '卖一价'}）`,
    money: (v: ActionView) => `${v.estNet >= 0 ? '到手' : '付出'}约 ${fmtNum(Math.abs(v.estNet), 2)} USD`,
    fee: (v: ActionView) => `手续费 ${fmtNum(v.estFee, 2)}`,
    pos: (v: ActionView) => `持仓 ${fmtQty(v.exposureBefore)} → ${fmtQty(v.exposureAfter)} ${v.sym}`,
    confirmFoot: '单击 = 确认（5 秒内可撤回）· 双击 = 返回',
    armed: (v: ActionView, s: number) => `${s} 秒后${v.side === 'SELL' ? '卖出' : '买入'} ${fmtQty(v.qty)} ${v.sym}`,
    sending: (v: ActionView) => `正在发送${v.side === 'SELL' ? '卖' : '买'}单 ${fmtQty(v.qty)} ${v.sym}…`,
    undoFoot: '单击 = 撤回 · 圆点走完之前什么都不会发出',
    sendingFoot: '已发出，等交易所回复',
    filled: (v: ActionView) => `完成：${v.side === 'SELL' ? '卖出' : '买入'} ${fmtQty(v.qty)} ${v.sym}，成交 ${fmtNum(v.fillPrice!, priceDigits(v.fillPrice!))}`,
    undone: '已撤回，什么都没发出。',
    failed: '没有执行，持仓没变。',
    resultFoot: '单击 = 回到持仓',
    sandbox: 'Coinbase 沙盒下单，已记入纸面账本',
  },
}

/** ●●●●○ style: filled dots = whole seconds left of a 5 s window. */
export function dots(remainMs: number, total = 5): string {
  const n = Math.max(0, Math.min(total, Math.ceil(remainMs / 1000)))
  return '●'.repeat(n) + '○'.repeat(total - n)
}

const box = (id: number, name: string, y: number, content: string, color: number, extra: Partial<Text> = {}): Text =>
  ({ id, name, x: 0, y, w: W, h: boxH(1), content: pxTruncate(content, W - 2 * PAD), color, ...extra })

export function confirmPage(v: ActionView, lang: Lang): Page {
  const t = A[lang]
  return {
    texts: [
      box(1, 'title', 0, t.title(v), 4, { h: boxH(1) + 2, border: true }),
      box(2, 'order', 54, t.order(v), 3),
      box(3, 'money', 98, t.money(v), 4),
      box(4, 'fee', 142, `${t.fee(v)} · ${t.pos(v)}`, 2),
      box(5, 'foot', FOOTER_Y, t.confirmFoot, 3, { capture: true }),
    ],
  }
}

export function undoPage(v: ActionView, lang: Lang): Page {
  const t = A[lang]
  const sending = v.status === 'sending'
  const sec = Math.max(0, Math.ceil((v.remainMs ?? 0) / 1000))
  return {
    texts: [
      box(1, 'title', 0, sending ? t.sending(v) : t.armed(v, sec), 4, { h: boxH(1) + 2, border: true }),
      box(2, 'dots', 70, sending ? '' : dots(v.remainMs ?? 0), 4),
      box(3, 'money', 126, t.money(v), 2),
      box(4, 'foot', FOOTER_Y, sending ? t.sendingFoot : t.undoFoot, 4, { capture: true }),
    ],
  }
}

export function resultPage(v: ActionView | null, lang: Lang, note?: string): Page {
  const t = A[lang]
  let line = note ?? ''
  let detail = ''
  let venue = ''
  if (v?.status === 'filled') { line = t.filled(v); detail = t.pos(v); if (v.venue === 'sandbox') venue = t.sandbox }
  else if (v?.status === 'undone') line = t.undone
  else if (v?.status === 'failed') { line = t.failed; detail = v.reason ?? '' }
  return {
    texts: [
      box(1, 'title', 0, line, 4, { h: boxH(1) + 2, border: true }),
      box(2, 'detail', 54, detail, 2),
      box(4, 'venue', 98, venue, 2),
      box(3, 'foot', FOOTER_Y, t.resultFoot, 3, { capture: true }),
    ],
  }
}

/** Context-menu entries of the PnL page. IDs encode the action so a click needs no lookup table. */
export const MENU_LANG = 90
export function menuItems(syms: string[], lang: Lang): { itemID: number; itemName: string }[] {
  const items: { itemID: number; itemName: string }[] = []
  syms.slice(0, 4).forEach((sym, i) => {
    items.push({ itemID: 10 * (i + 1) + 1, itemName: lang === 'zh' ? `${sym} 减半` : `Halve ${sym}` })
    items.push({ itemID: 10 * (i + 1) + 2, itemName: lang === 'zh' ? `${sym} 全部平仓` : `Close ${sym}` })
  })
  items.push({ itemID: MENU_LANG, itemName: lang === 'zh' ? 'English' : '中文' })
  return items
}
export function menuAction(itemID: number, syms: string[]): { kind: 'halve' | 'close'; sym: string } | null {
  const i = Math.floor(itemID / 10) - 1
  const k = itemID % 10
  if (i < 0 || i >= syms.length || (k !== 1 && k !== 2)) return null
  return { kind: k === 1 ? 'halve' : 'close', sym: syms[i] }
}
