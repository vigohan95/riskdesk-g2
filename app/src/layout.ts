// Pure layout for the 576x288 monochrome display. No SDK imports here so it is unit-testable in Node.
// Rules measured in the simulator before the hackathon (README "Display rules"):
// - line height 28 px; a text container needs h = lines x 28 + 2 x padding or a scrollbar appears
// - no text alignment and a proportional font -> right-align numbers by left-padding with normal
//   spaces (5 px), widths from the firmware glyph table (pretext). The firmware font has no thin
//   space (U+2009 logs "glyph not found" and falls back to a placeholder), so only real glyphs are used.
// - a 1 px border eats 2 px of that height (measured 11-23: h=44 + border showed a scrollbar)
// - one container per column (multi-line), not one per cell: the SDK allows 8 text containers
// - the footer is pinned at y=244 and is the event-capture layer
// - brightness (textColor 0-4) is the only emphasis on a monochrome panel

import { getTextWidth, pxTruncate } from '@evenrealities/pretext'
import type { RiskView } from './risk.ts'

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
export type Row = { product: string; sym: string; price: number; chg24: number; qty: number; avg: number | null; upnl: number | null; stop?: number | null; take?: number | null }
export type DeskState = {
  t: number
  feed: { status: 'connecting' | 'live' | 'stale'; ageMs: number | null }
  day: { pnl: number | null; pct: number | null }
  rows: Row[]
  openOrders: number
  alerts: number
  action: ActionView | null
  voice?: { status: 'listening' | 'thinking'; lang: Lang; seconds: number } | null
  notice?: { id: string; en: string; zh: string; heard: string | null; undo: string | null } | null
  /** per held product, live feed only (server/src/risk.ts) */
  risk?: RiskView[]
}
export type ActionView = {
  id: string
  status: 'proposed' | 'armed' | 'undone' | 'sending' | 'filled' | 'placed' | 'failed'
  kind: ActionKind
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
  venue: 'sandbox' | 'production' | 'paper'
  refPrice?: number
  trigger?: number | null
  /** bracket: the take-profit leg (trigger / estFee / estNet / replaces above are the stop leg) */
  take?: { trigger: number; estFee: number; estNet: number; replaces: number | null } | null
  replaces?: number | null
  affected?: number | null
  auto?: boolean
  heard?: string | null
  far?: boolean
}
export type ActionKind = 'halve' | 'close' | 'stop' | 'take' | 'bracket' | 'cancelAll'
export type PageKind = 'pnl' | 'confirm' | 'undo' | 'result' | 'voice' | 'notice' | 'risk'
/** An order in flight always wins; then a recording in progress; then a short notice; else positions. */
export function pageKind(s: DeskState | null): PageKind {
  switch (s?.action?.status) {
    case 'proposed': return 'confirm'
    case 'armed': case 'sending': return 'undo'
    case 'filled': case 'placed': case 'undone': case 'failed': return 'result'
  }
  if (s?.voice) return 'voice'
  if (s?.notice) return 'notice'
  return 'pnl'
}

const MINUS = '−'
const SP = ' '

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

/** Left-pad `s` with normal spaces so its right edge lands as close to `w` px as 5 px steps allow, never past it. */
export function rpad(s: string, w: number): string {
  // Measure whole strings: kerning between the space and the first glyph changes the step.
  let best = s
  let err = Math.abs(w - getTextWidth(s))
  for (let a = 1; ; a++) {
    const cand = SP.repeat(a) + s
    const cw = getTextWidth(cand)
    if (cw > w) break
    if (w - cw < err) { err = w - cw; best = cand }
  }
  return best
}

/**
 * Right-align a column. Spaces come in 5 px steps, so each line can miss the target by up to 4 px;
 * try the 5 possible targets w-4..w and keep the one where the lines' right edges agree best.
 */
export function alignCol(xs: string[], w: number): string[] {
  let best: string[] = xs
  let spread = Infinity
  for (let t = w; t > w - 5; t--) {
    const out = xs.map((s) => rpad(s, t))
    const ws = out.map((s) => getTextWidth(s))
    const sp = Math.max(...ws) - Math.min(...ws)
    if (sp < spread) { spread = sp; best = out }
  }
  return best
}
const col = (xs: string[], w: number) => alignCol(xs, w).join('\n')

const L = {
  en: { stopAt: (px: string, d: string) => `stop ${px} (${d}%)`, today: 'Today', na: '—', live: 'feed ● live', stale: (s: number) => `feed ○ STALE ${s}s · prices frozen`, connecting: 'feed ○ connecting…', offline: 'backend offline · retrying', open: (n: number) => `${n} open`, alerts: (n: number) => `${n} alert${n === 1 ? '' : 's'}`, flat: 'flat', old: 'old', worst: 'Worst', afterFees: 'after fees, if closed now', riskTap: 'tap = risk' },
  zh: { stopAt: (px: string, d: string) => `止损 ${px}（${d}%）`, today: '今日', na: '—', live: '行情 ● 实时', stale: (s: number) => `行情 ○ 中断 ${s} 秒 · 价格已冻结`, connecting: '行情 ○ 连接中…', offline: '后端离线 · 重试中', open: (n: number) => `挂单 ${n}`, alerts: (n: number) => `提醒 ${n}`, flat: '空仓', old: '旧价', worst: '最差', afterFees: '扣费后，按现在平仓', riskTap: '单击 = 风险' },
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
  // With a stop resting on the worst position, the distance to it is the more useful half of the line.
  const tail = worst?.stop ? t.stopAt(fmtNum(worst.stop, priceDigits(worst.stop)), signed(((worst.stop - worst.price) / worst.price) * 100, 1)) : t.afterFees
  const worstLine = worst
    ? `${t.worst}: ${worst.sym} ${signed(worst.upnl!, 2)} USD (${signed((worst.upnl! / (Math.abs(worst.qty) * worst.avg!)) * 100, 1)}%) · ${tail}`
    : ''
  let foot: string
  if (offline) foot = t.offline
  else if (!s || s.feed.status === 'connecting') foot = t.connecting
  else if (s.feed.status === 'stale') foot = t.stale(Math.round((s.feed.ageMs ?? 0) / 1000))
  else foot = `${t.open(s.openOrders)} · ${t.alerts(s.alerts)} · ${t.live}${s.risk?.length ? ` · ${t.riskTap}` : ''}`
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

export const pxs = (x: number) => fmtNum(x, priceDigits(x))
const pct = (v: ActionView) => signed(((v.trigger! - v.refPrice!) / v.refPrice!) * 100, 1)
const isResting = (v: ActionView) => v.kind === 'stop' || v.kind === 'take' || v.kind === 'bracket'
const pctOf = (x: number, ref: number) => signed(((x - ref) / ref) * 100, 1)
/** Bracket: the resting orders it replaces, e.g. "stop 59,780 · take 62,830" (only the legs that exist). */
const replacedLegs = (v: ActionView, s: string, t: string) =>
  [v.replaces ? `${s} ${pxs(v.replaces)}` : '', v.take?.replaces ? `${t} ${pxs(v.take.replaces)}` : ''].filter(Boolean).join(' · ')

/** Bracket (voice: "BTC stop 54k take 59k"): both legs on one page. The stop leg's money is the brightest
 *  line: it is the loss being capped. Sell legs watch the bid, buy legs (short) the ask. */
const B = {
  en: {
    title: (v: ActionView) => `Stop + take-profit on ${fmtQty(v.qty)} ${v.sym}?`,
    leg: (v: ActionView, k: 'S' | 'T', x: number, net: number) => {
      const book = v.side === 'SELL' ? 'bid' : 'ask'
      const le = (k === 'S') === (v.side === 'SELL') ? '≤' : '≥'
      return `${k === 'S' ? 'Stop' : 'Take'} ${book} ${le} ${pxs(x)} (${pctOf(x, v.refPrice!)}%) → ${net >= 0 ? 'get' : 'pay'} ≈ ${fmtNum(Math.abs(net), 2)} USD`
    },
    fee: (v: ActionView) => `first hit cancels the other · ${replacedLegs(v, 'stop', 'take') ? `replaces ${replacedLegs(v, 'stop', 'take')}` : `fee ≈ ${fmtNum(v.estFee, 2)}`}`,
    armed: (v: ActionView, s: number) => `Setting ${v.sym} stop ${pxs(v.trigger!)} + take ${pxs(v.take!.trigger)} in ${s} s`,
    money: (v: ActionView) => `at stop ≈ ${fmtNum(Math.abs(v.estNet), 2)} · at take ≈ ${fmtNum(Math.abs(v.take!.estNet), 2)} USD`,
    placed: (v: ActionView) => `Set: ${v.sym} stop ${pxs(v.trigger!)} · take ${pxs(v.take!.trigger)}`,
    oco: '; the first hit cancels the other',
  },
  zh: {
    title: (v: ActionView) => `${v.sym} ${fmtQty(v.qty)} 同时设止损 + 止盈？`,
    leg: (v: ActionView, k: 'S' | 'T', x: number, net: number) => {
      const book = v.side === 'SELL' ? '买一价' : '卖一价'
      const le = (k === 'S') === (v.side === 'SELL') ? '≤' : '≥'
      return `${k === 'S' ? '止损' : '止盈'} ${book} ${le} ${pxs(x)}（${pctOf(x, v.refPrice!)}%）→ ${net >= 0 ? '到手' : '付出'}约 ${fmtNum(Math.abs(net), 2)} USD`
    },
    fee: (v: ActionView) => `先触发的撤掉另一张 · ${replacedLegs(v, '止损', '止盈') ? `替换原来的${replacedLegs(v, '止损', '止盈')}` : `手续费约 ${fmtNum(v.estFee, 2)}`}`,
    armed: (v: ActionView, s: number) => `${s} 秒后挂 ${v.sym} 止损 ${pxs(v.trigger!)} + 止盈 ${pxs(v.take!.trigger)}`,
    money: (v: ActionView) => `止损时约 ${fmtNum(Math.abs(v.estNet), 2)} · 止盈时约 ${fmtNum(Math.abs(v.take!.estNet), 2)} USD`,
    placed: (v: ActionView) => `已设 ${v.sym} 止损 ${pxs(v.trigger!)} · 止盈 ${pxs(v.take!.trigger)}`,
    oco: '，先触发的撤掉另一张',
  },
}

/** Texts for stop / take-profit / cancel-all. Same page geometry as halve / close. */
const R = {
  en: {
    name: (v: ActionView) => (v.kind === 'stop' ? 'Stop-loss' : 'Take-profit'),
    title: (v: ActionView) => (v.kind === 'cancelAll' ? `Cancel all ${v.affected} open orders?` : `${R.en.name(v)} on ${v.sym}?`),
    order: (v: ActionView) => v.kind === 'cancelAll'
      ? 'Paper stop / take-profit orders. Positions stay as they are.'
      : `${v.side === 'SELL' ? 'Sell' : 'Buy'} ${fmtQty(v.qty)} ${v.sym} if ${v.side === 'SELL' ? 'bid' : 'ask'} ${(v.kind === 'stop') === (v.side === 'SELL') ? '≤' : '≥'} ${pxs(v.trigger!)} (${pct(v)}%)`,
    money: (v: ActionView) => (v.kind === 'cancelAll' ? 'Nothing is sold or bought.' : `${v.estNet >= 0 ? 'You would get' : 'You would pay'} ≈ ${fmtNum(Math.abs(v.estNet), 2)} USD`),
    fee: (v: ActionView) => (v.kind === 'cancelAll' ? '' : `fee ${fmtNum(v.estFee, 2)} · ${v.replaces ? `replaces ${pxs(v.replaces)}` : 'fires one market order'}`),
    armed: (v: ActionView, s: number) => (v.kind === 'cancelAll' ? `Cancelling ${v.affected} orders in ${s} s` : `Setting ${R.en.name(v).toLowerCase()} ${v.sym} ${pxs(v.trigger!)} in ${s} s`),
    placed: (v: ActionView) => (v.kind === 'cancelAll' ? `Cancelled ${v.affected} orders.` : `${R.en.name(v)} set: ${v.sym} at ${pxs(v.trigger!)}`),
    placedDetail: (v: ActionView) => (v.kind === 'cancelAll' ? 'Positions unchanged.' : `Paper order, watched against the live ${v.side === 'SELL' ? 'bid' : 'ask'}`),
    hit: (v: ActionView) => `${v.kind === 'stop' ? 'Stop hit' : 'Take-profit hit'}: ${v.side === 'SELL' ? 'sold' : 'bought'} ${fmtQty(v.qty)} ${v.sym} at ${pxs(v.fillPrice!)}`,
  },
  zh: {
    name: (v: ActionView) => (v.kind === 'stop' ? '止损' : '止盈'),
    title: (v: ActionView) => (v.kind === 'cancelAll' ? `撤销全部 ${v.affected} 张挂单？` : `${v.sym} 设${R.zh.name(v)}？`),
    order: (v: ActionView) => v.kind === 'cancelAll'
      ? '纸面止损 / 止盈单。持仓不变。'
      : `${v.side === 'SELL' ? '买一价' : '卖一价'} ${(v.kind === 'stop') === (v.side === 'SELL') ? '≤' : '≥'} ${pxs(v.trigger!)}（${pct(v)}%）时${v.side === 'SELL' ? '卖出' : '买入'} ${fmtQty(v.qty)} ${v.sym}`,
    money: (v: ActionView) => (v.kind === 'cancelAll' ? '不会买卖任何东西。' : `届时${v.estNet >= 0 ? '到手' : '付出'}约 ${fmtNum(Math.abs(v.estNet), 2)} USD`),
    fee: (v: ActionView) => (v.kind === 'cancelAll' ? '' : `手续费 ${fmtNum(v.estFee, 2)} · ${v.replaces ? `替换原来的 ${pxs(v.replaces)}` : '触发后发一张市价单'}`),
    armed: (v: ActionView, s: number) => (v.kind === 'cancelAll' ? `${s} 秒后撤销 ${v.affected} 张挂单` : `${s} 秒后挂 ${v.sym} ${R.zh.name(v)} ${pxs(v.trigger!)}`),
    placed: (v: ActionView) => (v.kind === 'cancelAll' ? `已撤销 ${v.affected} 张挂单。` : `已设${R.zh.name(v)}：${v.sym} ${pxs(v.trigger!)}`),
    placedDetail: (v: ActionView) => (v.kind === 'cancelAll' ? '持仓没变。' : `纸面挂单，盯实时${v.side === 'SELL' ? '买一价' : '卖一价'}`),
    hit: (v: ActionView) => `${v.kind === 'stop' ? '止损触发' : '止盈触发'}：${v.side === 'SELL' ? '卖出' : '买入'} ${fmtQty(v.qty)} ${v.sym}，成交 ${pxs(v.fillPrice!)}`,
  },
}

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
    paper: 'Browser demo: paper fill at the live bid/ask',
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
    paper: '网页演示：按实时买卖价记入纸面账本',
  },
}

/** ●●●●○ style: filled dots = whole seconds left of a 5 s window. */
export function dots(remainMs: number, total = 5): string {
  const n = Math.max(0, Math.min(total, Math.ceil(remainMs / 1000)))
  return '●'.repeat(n) + '○'.repeat(total - n)
}

export const box = (id: number, name: string, y: number, content: string, color: number, extra: Partial<Text> = {}): Text =>
  ({ id, name, x: 0, y, w: W, h: boxH(1), content: pxTruncate(content, W - 2 * PAD), color, ...extra })

/** Voice: what was heard, and a warning when the spoken price is far from the market. */
function heardLine(v: ActionView, lang: Lang): Text[] {
  if (!v.heard) return []
  const far = v.far ? (lang === 'zh' ? '离现价超过 20%，看清再点 · ' : 'over 20% from price, check it · ') : ''
  const said = lang === 'zh' ? `听到「${v.heard}」` : `heard "${v.heard}"`
  return [box(6, 'heard', 186, far + said, v.far ? 4 : 2)]
}

export function confirmPage(v: ActionView, lang: Lang): Page {
  const t = A[lang]
  if (v.kind === 'bracket' && v.take) {
    const b = B[lang]
    return {
      texts: [
        box(1, 'title', 0, b.title(v), 4, { h: boxH(1) + 2, border: true }),
        box(2, 'stop', 54, b.leg(v, 'S', v.trigger!, v.estNet), 4),
        box(3, 'take', 98, b.leg(v, 'T', v.take.trigger, v.take.estNet), 3),
        box(4, 'fee', 142, b.fee(v), 2),
        ...heardLine(v, lang),
        box(5, 'foot', FOOTER_Y, t.confirmFoot, 3, { capture: true }),
      ],
    }
  }
  if (v.kind === 'cancelAll' || isResting(v)) {
    const r = R[lang]
    return {
      texts: [
        box(1, 'title', 0, r.title(v), 4, { h: boxH(1) + 2, border: true }),
        box(2, 'order', 54, r.order(v), 3),
        box(3, 'money', 98, r.money(v), 4),
        box(4, 'fee', 142, r.fee(v), 2),
        ...heardLine(v, lang),
        box(5, 'foot', FOOTER_Y, t.confirmFoot, 3, { capture: true }),
      ],
    }
  }
  return {
    texts: [
      box(1, 'title', 0, t.title(v), 4, { h: boxH(1) + 2, border: true }),
      box(2, 'order', 54, t.order(v), 3),
      box(3, 'money', 98, t.money(v), 4),
      box(4, 'fee', 142, `${t.fee(v)} · ${t.pos(v)}`, 2),
      ...heardLine(v, lang),
      box(5, 'foot', FOOTER_Y, t.confirmFoot, 3, { capture: true }),
    ],
  }
}

export function undoPage(v: ActionView, lang: Lang): Page {
  const t = A[lang]
  const sending = v.status === 'sending'
  const sec = Math.max(0, Math.ceil((v.remainMs ?? 0) / 1000))
  const other = v.kind === 'cancelAll' || isResting(v)
  const bracket = v.kind === 'bracket' && !!v.take
  return {
    texts: [
      box(1, 'title', 0, sending ? t.sending(v) : bracket ? B[lang].armed(v, sec) : other ? R[lang].armed(v, sec) : t.armed(v, sec), 4, { h: boxH(1) + 2, border: true }),
      box(2, 'dots', 70, sending ? '' : dots(v.remainMs ?? 0), 4),
      box(3, 'money', 126, bracket ? B[lang].money(v) : other ? R[lang].money(v) : t.money(v), 2),
      box(4, 'foot', FOOTER_Y, sending ? t.sendingFoot : t.undoFoot, 4, { capture: true }),
    ],
  }
}

export function resultPage(v: ActionView | null, lang: Lang, note?: string): Page {
  const t = A[lang]
  let line = note ?? ''
  let detail = ''
  let venue = ''
  if (v?.status === 'filled') { line = v.auto ? R[lang].hit(v) : t.filled(v); detail = t.pos(v); if (v.venue === 'sandbox') venue = t.sandbox; else if (v.venue === 'paper') venue = t.paper }
  else if (v?.status === 'placed') { line = v.kind === 'bracket' && v.take ? B[lang].placed(v) : R[lang].placed(v); detail = R[lang].placedDetail(v) + (v.kind === 'bracket' ? B[lang].oco : '') }
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

const V = {
  en: {
    listening: (s: number) => `● Listening… ${s.toFixed(1)} s`,
    thinking: (s: number) => `Transcribing ${s.toFixed(1)} s of speech…`,
    hint: 'Say e.g. "halve BTC" · "ETH stop loss 1500"',
    hint1: '"alert me if bitcoin drops below 55k"',
    hint2: 'Nothing happens without a confirm tap.',
    listenFoot: 'release = done',
    thinkFoot: 'on this machine, audio never leaves it',
    heard: (h: string) => `heard "${h}"`,
    undoFoot: 'tap = remove this alert',
    backFoot: 'tap = back to positions',
  },
  zh: {
    listening: (s: number) => `● 正在听… ${s.toFixed(1)} 秒`,
    thinking: (s: number) => `识别中（${s.toFixed(1)} 秒语音）…`,
    hint: '比如说「BTC 减半」「以太坊止损 1500」',
    hint1: '「比特币跌破 5 万 5 提醒我」',
    hint2: '不点确认什么都不会发生。',
    listenFoot: '松开 = 说完了',
    thinkFoot: '本机识别，音频不出本机',
    heard: (h: string) => `听到「${h}」`,
    undoFoot: '单击 = 撤销这个提醒',
    backFoot: '单击 = 回到持仓',
  },
}

/** Hold-to-talk page: listening (with seconds) or transcribing. */
export function voicePage(s: NonNullable<DeskState['voice']>, lang: Lang): Page {
  const t = V[lang]
  const listening = s.status === 'listening'
  return {
    texts: [
      box(1, 'title', 0, listening ? t.listening(s.seconds) : t.thinking(s.seconds), 4, { h: boxH(1) + 2, border: true }),
      box(2, 'hint', 54, t.hint, 2),
      box(3, 'hint1', 98, t.hint1, 2),
      box(5, 'hint2', 142, t.hint2, 2),
      box(4, 'foot', FOOTER_Y, listening ? t.listenFoot : t.thinkFoot, 3, { capture: true }),
    ],
  }
}

/** Splits text into a first line that fits `w` px and the rest (broken after a space or CJK char / punctuation). */
export function splitLine(text: string, w: number): [string, string] {
  if (getTextWidth(text) <= w) return [text, '']
  const chars = [...text]
  let cut = 0, lastBreak = 0, lastPunct = 0
  for (let i = 1; i <= chars.length; i++) {
    if (getTextWidth(chars.slice(0, i).join('')) > w) break
    cut = i
    const c = chars[i - 1]
    // A digit-grouping comma (1,695) is not a break; a comma or full stop followed by a space is.
    const sentence = /[，。；：、]/.test(c) || (/[,.;:]/.test(c) && chars[i] === ' ')
    if (sentence) lastPunct = i
    if (c === ' ' || sentence || /[　-鿿＀-￯]/.test(c)) lastBreak = i
  }
  let at = lastPunct > cut / 2 ? lastPunct : lastBreak > cut / 2 ? lastBreak : cut
  // Never start the second line with closing punctuation (a lone "。"): pull one character down with it.
  while (at > 1 && /^[，。；：、）」』,.;:!?！？]/.test(chars[at] ?? '')) at--
  return [chars.slice(0, at).join('').trimEnd(), chars.slice(at).join('').trimStart()]
}

/** Alert set / alert hit / why a voice command did nothing. A long message continues on the second line. */
export function noticePage(n: NonNullable<DeskState['notice']>, lang: Lang): Page {
  const t = V[lang]
  const [first, rest] = splitLine(lang === 'zh' ? n.zh : n.en, W - 2 * PAD)
  const heard = n.heard ? t.heard(n.heard) : ''
  return {
    texts: [
      box(1, 'title', 0, first, 4, { h: boxH(1) + 2, border: true }),
      box(2, 'more', 54, rest, 4),
      box(4, 'detail', rest ? 98 : 54, heard, 2),
      box(3, 'foot', FOOTER_Y, n.undo ? t.undoFoot : t.backFoot, 3, { capture: true }),
    ],
  }
}

/** Context-menu entries of the PnL page. IDs encode the action so a click needs no lookup table:
 *  tens digit = symbol (1-based), units digit = action. The SDK allows 10 items of <= 32 UTF-8 bytes,
 *  so 4 actions x 2 symbols + cancel all + language fills it exactly; a third symbol only gets halve / close. */
export const MENU_LANG = 90
export const MENU_CANCEL_ALL = 80
export const MENU_MAX = 10
const KINDS: ('halve' | 'close' | 'stop' | 'take')[] = ['halve', 'close', 'stop', 'take']
const LABEL = {
  en: { halve: (s: string) => `Halve ${s}`, close: (s: string) => `Close ${s}`, stop: (s: string) => `Stop-loss ${s}`, take: (s: string) => `Take-profit ${s}`, cancelAll: 'Cancel all orders', lang: '中文' },
  zh: { halve: (s: string) => `${s} 减半`, close: (s: string) => `${s} 全部平仓`, stop: (s: string) => `${s} 设止损`, take: (s: string) => `${s} 设止盈`, cancelAll: '撤全部挂单', lang: 'English' },
}
export function menuItems(syms: string[], lang: Lang): { itemID: number; itemName: string }[] {
  const L = LABEL[lang]
  const items: { itemID: number; itemName: string }[] = []
  const per = syms.length <= 2 ? 4 : 2
  syms.slice(0, 4).forEach((sym, i) => {
    KINDS.slice(0, per).forEach((k, j) => items.push({ itemID: 10 * (i + 1) + j + 1, itemName: L[k](sym) }))
  })
  if (per === 4) items.push({ itemID: MENU_CANCEL_ALL, itemName: L.cancelAll })
  items.push({ itemID: MENU_LANG, itemName: L.lang })
  return items // <= 10 for any number of symbols (2 -> 10, 3 -> 7, 4 -> 9)
}
export function menuAction(itemID: number, syms: string[]): { kind: ActionKind; sym: string | null } | null {
  if (itemID === MENU_CANCEL_ALL) return { kind: 'cancelAll', sym: null }
  const i = Math.floor(itemID / 10) - 1
  const k = itemID % 10
  if (i < 0 || i >= syms.length || i >= 4 || k < 1 || k > 4) return null
  return { kind: KINDS[k - 1], sym: syms[i] }
}
