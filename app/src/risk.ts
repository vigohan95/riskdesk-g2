// Risk page: one held product per page. Left half is a 24 h chart (image container, 288x144 is the
// SDK maximum) with the entry / stop / take levels drawn on it; right half says what each level means
// in money. Numbers come from the server (state.risk, see server/src/risk.ts); the app only formats and draws.
// Pure (no SDK imports) so it is unit-testable in Node.

import { pxTruncate } from '@evenrealities/pretext'
import { W, PAD, FOOTER_Y, boxH, box, pxs, fmtNum, fmtQty, signed, type Lang, type Page } from './layout.ts'

export type RiskView = {
  product: string; sym: string; side: 'long' | 'short'; qty: number; avg: number; exit: number; upnl: number
  stop: number | null; stopPct: number | null; atStop: number | null; toStop: number | null
  take: number | null; takePct: number | null; atTake: number | null
  low24: number | null; high24: number | null; swing24: number | null
  stopVsRange: 'inside' | 'beyond' | null; stopBeyondPct: number | null
  closes: number[]; seriesFrom: number | null
}
export const CHART = { id: 20, name: 'chart', x: 0, y: 54, w: 288, h: 144 } as const

const K = {
  en: {
    title: (v: RiskView, i: number, n: number) => `${v.sym} risk · ${v.side} ${fmtQty(Math.abs(v.qty))} @ ${pxs(v.avg)}${n > 1 ? `  ${i + 1}/${n}` : ''}`,
    now: (v: RiskView) => `Now ${signed(v.upnl, 2)} USD`,
    stop: (v: RiskView) => (v.stop !== null ? `Stop ${pxs(v.stop)} (${signed(v.stopPct!, 1)}%)` : 'Stop: none'),
    take: (v: RiskView) => (v.take !== null ? `Take ${pxs(v.take)} (${signed(v.takePct!, 1)}%)` : 'Take-profit: none'),
    range: (v: RiskView) => (v.low24 !== null ? `24h ${pxs(v.low24)}–${pxs(v.high24!)}` : '24h range: loading'),
    atStop: (v: RiskView) => (v.atStop !== null ? `At stop ${signed(v.atStop, 2)} USD` : 'No stop: no floor'),
    note: (v: RiskView) => {
      if (v.stop === null) return v.swing24 !== null ? `24h range = ${fmtNum(v.swing24, 2)} USD on this position · Menu → Stop-loss` : 'Menu → Stop-loss to cap the loss'
      const lose = `${fmtNum(-Math.abs(v.toStop!), 2)} USD more if hit`
      if (v.stopVsRange === 'inside') return `Stop is inside the last 24h range · ${lose}`
      if (v.stopVsRange === 'beyond') return `Stop ${fmtNum(v.stopBeyondPct!, 1)}% ${v.side === 'long' ? `below 24h low ${pxs(v.low24!)}` : `above 24h high ${pxs(v.high24!)}`} · ${lose}`
      return lose
    },
    foot: (next: string | null) => (next ? `tap = next (${next}) · double-tap = positions` : 'tap = back to positions'),
    none: 'No open position: nothing at risk.',
    noneFoot: 'tap = back to positions',
  },
  zh: {
    title: (v: RiskView, i: number, n: number) => `${v.sym} 风险 · ${v.side === 'long' ? '多' : '空'} ${fmtQty(Math.abs(v.qty))} 均价 ${pxs(v.avg)}${n > 1 ? `  ${i + 1}/${n}` : ''}`,
    now: (v: RiskView) => `现在 ${signed(v.upnl, 2)} USD`,
    stop: (v: RiskView) => (v.stop !== null ? `止损 ${pxs(v.stop)}（${signed(v.stopPct!, 1)}%）` : '止损：没设'),
    take: (v: RiskView) => (v.take !== null ? `止盈 ${pxs(v.take)}（${signed(v.takePct!, 1)}%）` : '止盈：没设'),
    range: (v: RiskView) => (v.low24 !== null ? `24h ${pxs(v.low24)}–${pxs(v.high24!)}` : '24h 区间：加载中'),
    atStop: (v: RiskView) => (v.atStop !== null ? `止损时 ${signed(v.atStop, 2)} USD` : '没止损：亏损没有底'),
    note: (v: RiskView) => {
      if (v.stop === null) return v.swing24 !== null ? `过去 24h 振幅折合这笔仓位 ${fmtNum(v.swing24, 2)} USD · 菜单 → 设止损` : '菜单 → 设止损'
      const lose = `打到再亏 ${fmtNum(Math.abs(v.toStop!), 2)} USD`
      if (v.stopVsRange === 'inside') return `止损在过去 24h 区间内 · ${lose}`
      if (v.stopVsRange === 'beyond') return `止损比 24h ${v.side === 'long' ? `低点 ${pxs(v.low24!)} 再低` : `高点 ${pxs(v.high24!)} 再高`} ${fmtNum(v.stopBeyondPct!, 1)}% · ${lose}`
      return lose
    },
    foot: (next: string | null) => (next ? `单击 = 下一个（${next}）· 双击 = 回到持仓` : '单击 = 回到持仓'),
    none: '没有持仓，没有风险。',
    noneFoot: '单击 = 回到持仓',
  },
}

/** Risk page for risk[i]; `chart` is the view to draw into the image container (null: no image). */
export function riskPage(risk: RiskView[], i: number, lang: Lang): Page & { chart: RiskView | null } {
  const t = K[lang]
  const v = risk[i]
  if (!v) {
    return {
      texts: [
        box(1, 'title', 0, t.none, 4, { h: boxH(1) + 2, border: true }),
        box(2, 'foot', FOOTER_Y, t.noneFoot, 3, { capture: true }),
      ],
      chart: null,
    }
  }
  const next = i + 1 < risk.length ? risk[i + 1].sym : null
  const RW = W - CHART.w
  const info = [t.now(v), t.stop(v), t.take(v)].map((s) => pxTruncate(s, RW - 2 * PAD)).join('\n')
  // The note under the chart is the line to read at a glance: brightest when the stop is missing or inside the 24 h range.
  const warn = v.stop === null || v.stopVsRange === 'inside'
  return {
    texts: [
      box(1, 'title', 0, t.title(v, i, risk.length), 4, { h: boxH(1) + 2, border: true }),
      { id: 2, name: 'info', x: CHART.w, y: 54, w: RW, h: boxH(3), content: info, color: 3 },
      { id: 3, name: 'atstop', x: CHART.w, y: 54 + boxH(3), w: RW, h: boxH(1), content: pxTruncate(t.atStop(v), RW - 2 * PAD), color: 4 },
      box(4, 'note', 200, t.note(v), warn ? 4 : 2),
      box(5, 'foot', FOOTER_Y, t.foot(next), 3, { capture: true }),
    ],
    chart: v,
  }
}

/**
 * 24 h chart as 8-bit grey pixels (w x h, row-major); the host turns it into 4-bit grey.
 * Price line 2 px at full brightness, last price a 5x5 dot, entry a long-dash line, stop a short-dash
 * bright line, take-profit a dotted dim line. A level far outside the chart is pinned to the edge with
 * a sparse pattern so it reads "off the chart that way" instead of squashing the price line flat.
 */
export function chartPixels(v: RiskView, w: number = CHART.w, h: number = CHART.h): Uint8Array {
  const px = new Uint8Array(w * h)
  const xs = v.closes
  if (xs.length < 2) return px
  const PADY = 8
  let lo = Math.min(...xs, v.low24 ?? Infinity)
  let hi = Math.max(...xs, v.high24 ?? -Infinity)
  const span = hi - lo || hi * 0.001
  // Pull a level into the scale only when the price line keeps at least a third of the height.
  for (const lvl of [v.avg, v.stop, v.take]) {
    if (lvl === null) continue
    if (lvl < lo && hi - lvl <= 3 * span) lo = lvl
    if (lvl > hi && lvl - lo <= 3 * span) hi = lvl
  }
  const yOf = (p: number) => {
    const y = Math.round(PADY + (1 - (p - lo) / (hi - lo || 1)) * (h - 1 - 2 * PADY))
    return Math.max(0, Math.min(h - 1, y))
  }
  const set = (x: number, y: number, g: number) => { if (x >= 0 && x < w && y >= 0 && y < h && px[y * w + x] < g) px[y * w + x] = g }
  const hline = (p: number | null, on: number, off: number, g: number) => {
    if (p === null) return
    const pinned = p < lo || p > hi
    const y = pinned ? (p < lo ? h - 2 : 1) : yOf(p)
    for (let x = 0; x < w; x++) if (x % (pinned ? 8 : on + off) < (pinned ? 2 : on)) { set(x, y, g); if (pinned) set(x, y - 1, g) }
  }
  hline(v.take, 1, 3, 110)
  hline(v.avg, 8, 4, 140)
  hline(v.stop, 3, 2, 230)
  // 3x5 letter at the left end of each level: S(top) E(ntry) T(ake); the README legend explains them.
  const tag = (p: number | null, glyph: string[], g: number) => {
    if (p === null) return
    const pinned = p < lo || p > hi
    const y = pinned ? (p < lo ? h - 2 : 1) : yOf(p)
    // 6x10 px (each glyph cell doubled), above the line, or below it when the line is near the top edge
    const top = y >= 13 ? y - 12 : y + 3
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if (glyph[r][c] === '#') for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 1]]) set(2 + 2 * c + a, top + 2 * r + b, g)
  }
  tag(v.take, TAG_T, 170)
  tag(v.avg, TAG_E, 170)
  tag(v.stop, TAG_S, 255)
  const n = xs.length
  const xOf = (k: number) => Math.round((k / (n - 1)) * (w - 4))
  for (let k = 1; k < n; k++) {
    let x0 = xOf(k - 1), y0 = yOf(xs[k - 1])
    const x1 = xOf(k), y1 = yOf(xs[k])
    // Bresenham, 2 px thick (a 1 px line is too faint on the panel)
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
    let err = dx + dy
    for (;;) {
      set(x0, y0, 255); set(x0, y0 + 1, 255)
      if (x0 === x1 && y0 === y1) break
      const e2 = 2 * err
      if (e2 >= dy) { err += dy; x0 += sx }
      if (e2 <= dx) { err += dx; y0 += sy }
    }
  }
  const lx = xOf(n - 1), ly = yOf(xs[n - 1])
  for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) set(lx + a, ly + b, 255)
  return px
}

const TAG_S = ['###', '#..', '###', '..#', '###']
const TAG_E = ['###', '#..', '##.', '#..', '###']
const TAG_T = ['###', '.#.', '.#.', '.#.', '.#.']

/** Change key: the image (~100 ms per send, limited glasses memory) is re-sent only when it would look different. */
export function chartKey(v: RiskView | null): string {
  if (!v) return ''
  const last = v.closes[v.closes.length - 1] ?? 0
  const span = (v.high24 ?? last) - (v.low24 ?? last) || 1
  // last price quantised to ~1 px of the chart height
  return [v.product, v.closes.length, v.seriesFrom, v.avg, v.stop, v.take, v.low24, v.high24, Math.round((last / span) * 136)].join('|')
}
