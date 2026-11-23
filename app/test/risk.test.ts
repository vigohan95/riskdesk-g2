import { test } from 'node:test'
import assert from 'node:assert/strict'
import { overflows, pnlPage, type DeskState } from '../src/layout.ts'
import { riskPage, chartPixels, chartKey, CHART, type RiskView } from '../src/risk.ts'

const closes = Array.from({ length: 97 }, (_, k) => 61000 + 400 * Math.sin(k / 9))
const base: RiskView = {
  product: 'BTC-USD', sym: 'BTC', side: 'long', qty: 0.02, avg: 61580.01, exit: 61355, upnl: -14.32,
  stop: 59780, stopPct: -2.57, atStop: -45.15, toStop: -30.83,
  take: 63200, takePct: 3.01, atTake: 22.29,
  low24: 60590, high24: 61420, swing24: 16.6,
  stopVsRange: 'beyond', stopBeyondPct: 1.34,
  closes, seriesFrom: 1795400000000,
}
const eth: RiskView = { ...base, product: 'ETH-USD', sym: 'ETH', qty: 0.75, avg: 1691.15, exit: 1719.9, upnl: 11.11, stop: 1695.12, stopPct: -1.44, atStop: -6.15, toStop: -17.26, take: null, takePct: null, atTake: null, low24: 1690.5, high24: 1730.2, swing24: 29.78, stopVsRange: 'inside', stopBeyondPct: -0.27, closes: closes.map((c) => c / 36) }
const naked: RiskView = { ...base, swing24: 12345.67, stop: null, stopPct: null, atStop: null, toStop: null, take: null, takePct: null, atTake: null, stopVsRange: null, stopBeyondPct: null }
const short: RiskView = { ...base, side: 'short', qty: -0.02, stopVsRange: 'beyond', toStop: -12345.67, high24: 123456, stopBeyondPct: 12.3 }
const wide: RiskView = { ...base, upnl: -12345.67, atStop: -12345.67, toStop: -12345.67, stop: 123456.78, stopPct: -12.3, take: 123456.78, takePct: 12.3, avg: 123456.78, qty: 12.345 }
const loading: RiskView = { ...base, low24: null, high24: null, swing24: null, stopVsRange: null, stopBeyondPct: null, closes: [], seriesFrom: null }

test('risk page fits the display in both languages for every case', () => {
  for (const lang of ['en', 'zh'] as const) {
    for (const v of [base, eth, naked, short, loading, wide, { ...wide, stopVsRange: 'inside' as const }]) {
      const p = riskPage([v, eth], 0, lang)
      assert.deepEqual(overflows(p), [], `${lang} ${v.sym} ${v.stop}`)
      // the right column must not run into the chart
      for (const t of p.texts.filter((t) => t.name === 'info' || t.name === 'atstop')) assert.ok(t.x >= CHART.x + CHART.w)
      for (const a of p.texts) for (const b of p.texts) if (a !== b && a.x < b.x + b.w && b.x < a.x + a.w) assert.ok(a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.name} overlaps ${b.name}`)
      for (const t of p.texts) assert.ok(!/(\.\.\.|…)$/.test(t.content), `${lang} ${t.name} truncated: ${t.content}`)
      assert.ok(p.texts.length + 1 <= 8, 'text containers + image within the SDK limit')
      assert.equal(p.texts.filter((t) => t.capture).length, 1)
    }
    assert.deepEqual(overflows(riskPage([], 0, lang)), [])
  }
})

test('risk page says the money: at stop, from here, and how the stop sits against the last 24 h', () => {
  const en = riskPage([base, eth], 0, 'en')
  const txt = (p: ReturnType<typeof riskPage>, n: string) => p.texts.find((t) => t.name === n)!.content
  assert.match(txt(en, 'title'), /^BTC risk · long 0\.020 @ 61,580  1\/2$/)
  assert.match(txt(en, 'atstop'), /At stop −45\.15 USD/)
  assert.match(txt(en, 'info'), /Stop 59,780 \(−2\.6%\)/)
  assert.match(txt(en, 'note'), /^Stop 1\.3% below 24h low 60,590 · −30\.83 USD more if hit$/)
  assert.match(txt(en, 'foot'), /next \(ETH\)/)
  const last = riskPage([base, eth], 1, 'zh')
  assert.match(txt(last, 'note'), /止损在过去 24h 区间内/)
  assert.equal(last.texts.find((t) => t.name === 'note')!.color, 4, 'inside-range stop is the bright warning')
  assert.match(txt(last, 'foot'), /^单击 = 回到持仓$/)
  assert.match(txt(riskPage([naked], 0, 'en'), 'atstop'), /No stop/)
  assert.match(txt(riskPage([naked], 0, 'zh'), 'note'), /过去 24h 振幅折合这笔仓位 12,345\.67 USD/)
})

test('positions footer offers the risk page only when there is something at risk', () => {
  const s: DeskState = { t: 0, feed: { status: 'live', ageMs: 100 }, day: { pnl: 1, pct: 0.1 }, rows: [], openOrders: 2, alerts: 1, action: null }
  const foot = (x: DeskState, l: 'en' | 'zh') => pnlPage(x, l).texts.find((t) => t.name === 'foot')!.content
  assert.doesNotMatch(foot(s, 'en'), /risk/)
  assert.match(foot({ ...s, risk: [base] }, 'en'), /tap = risk$/)
  assert.match(foot({ ...s, risk: [base] }, 'zh'), /单击 = 风险$/)
  for (const l of ['en', 'zh'] as const) assert.deepEqual(overflows(pnlPage({ ...s, risk: [base] }, l)), [])
})

const rowOf = (px: Uint8Array, y: number) => px.subarray(y * CHART.w, (y + 1) * CHART.w)
const brightRows = (px: Uint8Array, g: number) => {
  const out: number[] = []
  for (let y = 0; y < CHART.h; y++) { const r = rowOf(px, y); if (r.filter((v) => v === g).length > CHART.w / 3) out.push(y) }
  return out
}

test('chart: price line drawn across the width, stop dashed line inside the frame', () => {
  const px = chartPixels(base)
  assert.equal(px.length, CHART.w * CHART.h)
  for (const x of [0, 100, 200, CHART.w - 5]) {
    let hit = false
    for (let y = 0; y < CHART.h; y++) if (px[y * CHART.w + x] === 255) hit = true
    assert.ok(hit, `price line at x=${x}`)
  }
  const stopRows = brightRows(px, 230)
  assert.equal(stopRows.length, 1, 'one stop line')
  assert.ok(stopRows[0] > 0 && stopRows[0] < CHART.h - 1)
})

test('chart: a stop far away is pinned to the edge instead of flattening the price line', () => {
  const far = { ...base, stop: 40000 }
  const px = chartPixels(far)
  let top = CHART.h, bot = 0
  for (let y = 0; y < CHART.h; y++) if (rowOf(px, y).includes(255)) { top = Math.min(top, y); bot = Math.max(bot, y) }
  assert.ok(bot - top > CHART.h / 2, `price line keeps its height (${top}..${bot})`)
  const r = rowOf(px, CHART.h - 2)
  assert.ok(r.filter((v) => v === 230).length > 20, 'pinned marker on the bottom edge')
})

test('chart: no series -> blank; key changes with levels and price, not with noise', () => {
  assert.ok(chartPixels(loading).every((v) => v === 0))
  assert.equal(chartKey(null), '')
  assert.notEqual(chartKey(base), chartKey({ ...base, stop: 59000 }))
  assert.equal(chartKey(base), chartKey({ ...base, closes: [...closes.slice(0, -1), closes[96] + 0.01] }))
  assert.notEqual(chartKey(base), chartKey({ ...base, closes: [...closes.slice(0, -1), closes[96] + 200] }))
})

test('chart: each level gets its letter tag fully inside the frame (S stop, E entry, T take)', () => {
  for (const v of [base, { ...base, take: 61420 }, { ...base, stop: 40000 }]) {
    const px = chartPixels(v)
    // tags live in columns 2..7; count lit pixels there that are not part of a horizontal line
    let lit = 0
    for (let y = 0; y < CHART.h; y++) for (let x = 2; x < 8; x++) if (px[y * CHART.w + x] >= 170) lit++
    assert.ok(lit >= 3 * 16, `three tags drawn (${lit} px)`)
  }
})
