import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getTextWidth } from '@evenrealities/pretext'
import { pnlPage, overflows, rpad, alignCol, fmtNum, signed, type DeskState } from '../src/layout.ts'

// Shape of a real /api/state response captured 2026-11-23 08:28 UTC.
const real: DeskState = {
  t: 1795422520024,
  feed: { status: 'live', ageMs: 133 },
  day: { pnl: -3.386913600000298, pct: -0.1348783477375282 },
  rows: [
    { product: 'BTC-USD', sym: 'BTC', price: 61239.7, chg24: 2.75155378090322, qty: 0.02, avg: 61580.01, upnl: -16.62895520000002 },
    { product: 'ETH-USD', sym: 'ETH', price: 1719.94, chg24: 2.32621784345922, qty: 0.75, avg: 1691.15, upnl: 11.10918 },
  ],
  openOrders: 0,
  action: null,
  alerts: 0,
}

test('number formatting uses a real minus sign and no "-0.00"', () => {
  assert.equal(fmtNum(-1234.5, 2), '−1,234.50')
  assert.equal(signed(12.3, 2), '+12.30')
  assert.equal(signed(-0.001, 2), '0.00')
  assert.equal(signed(0.001, 2), '0.00')
})

test('rpad uses only glyphs the firmware font has and never overshoots', () => {
  for (const s of ['61,240', '1,719.9', '+2.8%', '−0.1%', '0.020  −16.63']) {
    const out = rpad(s, 150)
    assert.ok(!/[ -​ ]/.test(out), `${s}: thin/odd space`)
    const w = getTextWidth(out)
    assert.ok(w <= 150 && w >= 146, `${s}: ${w}`)
  }
})

test('alignCol keeps right edges of real price columns within 3 px (3 lines in 5 px steps cannot do better)', () => {
  // real column inner widths from pnlPage: price 104, 24h 80, position 244
  const cols: [string[], number][] = [[['61,377', '1,722.6', '—'], 104], [['+2.7%', '+2.4%', '−0.1%'], 80], [['0.020  −13.88', '0.750  +13.27', 'flat'], 244], [['64,310', '1,719.9', '187.42'], 104]]
  for (const [xs, w] of cols) {
    const ws = alignCol(xs, w).map((s) => getTextWidth(s))
    assert.ok(Math.max(...ws) - Math.min(...ws) <= 3 && Math.max(...ws) <= w, `${xs}: ${ws}`)
  }
})

test('PnL page from real state: content and no overflow, en + zh', () => {
  for (const lang of ['en', 'zh'] as const) {
    const p = pnlPage(real, lang)
    assert.deepEqual(overflows(p), [], lang)
    const by = Object.fromEntries(p.texts.map((t) => [t.name, t]))
    assert.match(by.head.content, /−3\.39 USD {2}\(−0\.13%\)/)
    assert.match(by.px.content, /61,240\n.*1,719\.9$/s)
    assert.match(by.worst.content, /BTC −16\.63/)
    assert.equal(by.foot.capture, true)
    assert.equal(by.foot.y, 244)
    assert.ok(p.texts.length <= 8)
  }
})

test('stale feed dims prices and says so in the footer', () => {
  const p = pnlPage({ ...real, feed: { status: 'stale', ageMs: 5200 } }, 'en')
  const by = Object.fromEntries(p.texts.map((t) => [t.name, t]))
  assert.equal(by.px.color, 1)
  assert.match(by.foot.content, /STALE 5s/)
  assert.equal(by.chg.content.trim().split(String.fromCharCode(10)).map((x) => x.trim()).join(','), 'old,old')
  assert.equal(by.foot.color, 4)
})

test('unknown day PnL renders a dash, never a zero', () => {
  const p = pnlPage({ ...real, day: { pnl: null, pct: null } }, 'zh')
  assert.equal(p.texts[0].content, '今日  —')
})

test('connecting / offline states render without data', () => {
  assert.deepEqual(overflows(pnlPage(null, 'en')), [])
  assert.match(pnlPage(real, 'en', true).texts.at(-1)!.content, /offline/)
})

test('geometry never depends on data (upgrade can change text, not size)', () => {
  const geo = (p: ReturnType<typeof pnlPage>) => p.texts.map((t) => [t.id, t.x, t.y, t.w, t.h].join(','))
  const base = geo(pnlPage(null, 'en'))
  assert.deepEqual(geo(pnlPage(real, 'en')), base)
  assert.deepEqual(geo(pnlPage({ ...real, rows: real.rows.slice(0, 1) }, 'zh')), base)
})

// ---- action pages (Day 2) ----
import { confirmPage, undoPage, resultPage, pageKind, dots, menuItems, menuAction, MENU_LANG, type ActionView } from '../src/layout.ts'

// Shape of a real /api/preview -> /api/state action, 2026-11-23 (BTC halve at the live bid).
const act: ActionView = {
  id: '0f7c', status: 'proposed', kind: 'halve', sym: 'BTC', side: 'SELL', qty: 0.01, estPrice: 61238.4, estFee: 4.899072,
  estNet: 607.484928, exposureBefore: 0.02, exposureAfter: 0.01, remainMs: null, fillPrice: null, reason: null, venue: 'sandbox',
}

test('action pages fit, en + zh, every status', () => {
  const cases: ActionView[] = [
    act,
    { ...act, kind: 'close', qty: 0.75, sym: 'ETH', estPrice: 1719.9, estNet: 1279.6, exposureBefore: 0.75, exposureAfter: 0 },
    { ...act, status: 'armed', remainMs: 3400 },
    { ...act, status: 'sending' },
    { ...act, status: 'filled', fillPrice: 61240.1 },
    { ...act, status: 'undone' },
    { ...act, status: 'failed', reason: 'price moved >1%, look again' },
  ]
  for (const lang of ['en', 'zh'] as const) {
    for (const v of cases) {
      for (const p of [confirmPage(v, lang), undoPage(v, lang), resultPage(v, lang)]) assert.deepEqual(overflows(p), [], `${lang} ${v.status}`)
    }
    assert.deepEqual(overflows(resultPage(null, lang, 'no ETH-USD position')), [])
  }
})

test('confirm page: money line is brightest, footer is the only capture layer and says what a tap does', () => {
  const p = confirmPage(act, 'en')
  const by = Object.fromEntries(p.texts.map((t) => [t.name, t]))
  assert.equal(by.money.content, 'You get ≈ 607.48 USD')
  assert.equal(by.money.color, 4)
  assert.match(by.order.content, /Sell 0\.010 BTC at ≈ 61,238 \(bid\)/)
  assert.deepEqual(p.texts.filter((t) => t.capture).map((t) => t.name), ['foot'])
  assert.match(confirmPage(act, 'zh').texts[2].content, /^到手约 607\.48 USD$/)
})

test('filled result says it was a sandbox order', () => {
  for (const lang of ['en', 'zh'] as const) {
    const p = resultPage({ ...act, status: 'filled', fillPrice: 61240.1 }, lang)
    assert.match(p.texts.find((t) => t.name === 'venue')!.content, /sandbox|沙盒/)
    assert.equal(resultPage({ ...act, status: 'filled', fillPrice: 61240.1, venue: 'production' }, lang).texts.find((t) => t.name === 'venue')!.content, '')
  }
})

test('undo countdown dots and page kinds', () => {
  assert.equal(dots(5000), '●●●●●')
  assert.equal(dots(4001), '●●●●●')
  assert.equal(dots(4000), '●●●●○')
  assert.equal(dots(1), '●○○○○')
  assert.equal(dots(0), '○○○○○')
  const st = (status: ActionView['status'] | null) => ({ ...real, action: status ? { ...act, status } : null })
  assert.equal(pageKind(st(null)), 'pnl')
  assert.equal(pageKind(st('proposed')), 'confirm')
  assert.equal(pageKind(st('armed')), 'undo')
  assert.equal(pageKind(st('sending')), 'undo')
  for (const s of ['filled', 'undone', 'failed'] as const) assert.equal(pageKind(st(s)), 'result')
})

test('context menu: <= 10 items, labels <= 32 UTF-8 bytes, ids non-zero and unique, ids decode back', () => {
  for (const lang of ['en', 'zh'] as const) {
    const m = menuItems(['BTC', 'ETH'], lang)
    assert.ok(m.length <= 10)
    assert.equal(new Set(m.map((x) => x.itemID)).size, m.length)
    for (const x of m) {
      assert.ok(x.itemID > 0)
      assert.ok(new TextEncoder().encode(x.itemName).length <= 32, x.itemName)
    }
  }
  assert.deepEqual(menuAction(11, ['BTC', 'ETH']), { kind: 'halve', sym: 'BTC' })
  assert.deepEqual(menuAction(22, ['BTC', 'ETH']), { kind: 'close', sym: 'ETH' })
  assert.equal(menuAction(MENU_LANG, ['BTC', 'ETH']), null)
  assert.equal(menuAction(31, ['BTC', 'ETH']), null)
})

// ---- stop / take-profit / cancel all (Day 2b) ----
const stop: ActionView = {
  ...act, kind: 'stop', qty: 0.02, estPrice: 59780.2, trigger: 59780.2, refPrice: 61000.2, estFee: 9.56, estNet: 1186.04,
  exposureBefore: 0.02, exposureAfter: 0, replaces: null, affected: null, auto: false,
}
const cancelAll: ActionView = { ...act, kind: 'cancelAll', sym: '', qty: 0, estPrice: 0, estFee: 0, estNet: 0, refPrice: 0, trigger: null, affected: 3, auto: false }

test('stop / take / cancel-all pages fit in every status, en + zh', () => {
  const take: ActionView = { ...stop, kind: 'take', trigger: 1771.6, estPrice: 1771.6, refPrice: 1720, sym: 'ETH', qty: 0.75, replaces: 1760.2 }
  const short: ActionView = { ...stop, side: 'BUY', trigger: 62220, refPrice: 61001, estNet: -1254.4, exposureBefore: -0.02 }
  const all = [stop, take, short, cancelAll]
  for (const lang of ['en', 'zh'] as const) {
    for (const v0 of all) {
      for (const v of [v0, { ...v0, status: 'armed' as const, remainMs: 2100 }, { ...v0, status: 'placed' as const }, { ...v0, status: 'undone' as const }]) {
        for (const p of [confirmPage(v, lang), undoPage(v, lang), resultPage(v, lang)]) assert.deepEqual(overflows(p), [], `${lang} ${v.kind} ${v.status}`)
      }
    }
    const hit = resultPage({ ...stop, status: 'filled', auto: true, fillPrice: 59700 }, lang)
    assert.deepEqual(overflows(hit), [])
  }
})

test('stop confirm page states the trigger, its side of the book and distance; cancel-all says positions stay', () => {
  const by = (p: ReturnType<typeof confirmPage>) => Object.fromEntries(p.texts.map((t) => [t.name, t.content]))
  const en = by(confirmPage(stop, 'en'))
  assert.equal(en.title, 'Stop-loss on BTC?')
  assert.equal(en.order, 'Sell 0.020 BTC if bid ≤ 59,780 (−2.0%)')
  assert.equal(en.money, 'You would get ≈ 1,186.04 USD')
  assert.match(en.fee, /fires one market order/)
  assert.match(by(confirmPage({ ...stop, replaces: 59500 }, 'en')).fee, /replaces 59,500/)
  const zh = by(confirmPage(stop, 'zh'))
  assert.equal(zh.order, '买一价 ≤ 59,780（−2.0%）时卖出 0.020 BTC')
  // short position: stop is a buy above the ask
  assert.equal(by(confirmPage({ ...stop, side: 'BUY', trigger: 62220, refPrice: 61001 }, 'en')).order, 'Buy 0.020 BTC if ask ≥ 62,220 (+2.0%)')
  const c = by(confirmPage(cancelAll, 'en'))
  assert.equal(c.title, 'Cancel all 3 open orders?')
  assert.match(c.order, /Positions stay/)
  assert.equal(by(resultPage({ ...cancelAll, status: 'placed' }, 'zh')).title, '已撤销 3 张挂单。')
})

test('a stop that fires by itself says so on the result page', () => {
  const p = resultPage({ ...stop, status: 'filled', auto: true, fillPrice: 59700 }, 'en')
  assert.equal(p.texts[0].content, 'Stop hit: sold 0.020 BTC at 59,700')
  assert.equal(pageKind({ ...real, action: { ...stop, status: 'placed' } }), 'result')
})

test('worst line shows the distance to a resting stop instead of the fee note', () => {
  const rows = real.rows.map((r) => (r.sym === 'BTC' ? { ...r, stop: 59780 } : r))
  const w = pnlPage({ ...real, rows, openOrders: 1 }, 'en').texts.find((t) => t.name === 'worst')!.content
  assert.match(w, /stop 59,780 \(−2\.4%\)/)
  assert.match(pnlPage({ ...real, rows }, 'zh').texts.find((t) => t.name === 'worst')!.content, /止损 59,780（−2\.4%）/)
})

test('full menu: 2 symbols x 4 actions + cancel all + language = exactly 10, all decode', () => {
  for (const lang of ['en', 'zh'] as const) {
    const m = menuItems(['BTC', 'ETH'], lang)
    assert.equal(m.length, 10)
    for (const x of m) assert.ok(new TextEncoder().encode(x.itemName).length <= 32, x.itemName)
    for (const x of m) if (x.itemID !== MENU_LANG) assert.ok(menuAction(x.itemID, ['BTC', 'ETH']), String(x.itemID))
  }
  assert.deepEqual(menuAction(13, ['BTC', 'ETH']), { kind: 'stop', sym: 'BTC' })
  assert.deepEqual(menuAction(24, ['BTC', 'ETH']), { kind: 'take', sym: 'ETH' })
  assert.deepEqual(menuAction(80, ['BTC', 'ETH']), { kind: 'cancelAll', sym: null })
  assert.ok(menuItems(['BTC', 'ETH', 'SOL', 'XRP'], 'zh').length <= 10)
})

// ---- voice (Day 3b) ----
import { voicePage, noticePage } from '../src/layout.ts'

test('voice: listening / transcribing / notice pages fit, en + zh', () => {
  for (const lang of ['en', 'zh'] as const) {
    for (const v of [{ status: 'listening', lang, seconds: 2.3 }, { status: 'thinking', lang, seconds: 14.9 }] as const) {
      assert.deepEqual(overflows(voicePage(v, lang)), [], `${lang} ${v.status}`)
    }
    const n = { id: 'n1', en: 'Alert set: BTC below 55,000 (replaces 54,000) · over 20% away', zh: '已设提醒：BTC 跌破 55,000（替换原来的 54,000）· 离现价超过 20%', heard: '比特币跌破五万五提醒我。'.repeat(4), undo: 'a1' }
    const p = noticePage(n, lang)
    assert.deepEqual(overflows(p), [], lang)
    assert.match(p.texts.at(-1)!.content, lang === 'zh' ? /撤销/ : /remove/)
    assert.match(noticePage({ ...n, undo: null }, lang).texts.at(-1)!.content, lang === 'zh' ? /回到持仓/ : /back/)
  }
})

test('voice: confirm page shows what was heard and flags a far price, still fits', () => {
  for (const lang of ['en', 'zh'] as const) {
    const plain = confirmPage(stop, lang)
    assert.equal(plain.texts.find((t) => t.name === 'heard'), undefined)
    for (const v of [{ ...stop, heard: 'Set a stop loss on BTC at fifty nine thousand seven hundred eighty point two please', far: false }, { ...act, heard: '比特币减半', far: false }, { ...stop, heard: 'BTC stop 40000', far: true }]) {
      const p = confirmPage(v, lang)
      assert.deepEqual(overflows(p), [], `${lang} ${v.heard}`)
      const h = p.texts.find((t) => t.name === 'heard')!
      assert.ok(h.content.includes(lang === 'zh' ? '听到' : 'heard'))
      assert.equal(h.color, v.far ? 4 : 2)
      assert.ok(p.texts.length <= 8)
    }
  }
})

test('voice: an order in flight beats a recording, a recording beats a notice', () => {
  const base = { ...real, voice: { status: 'listening', lang: 'en', seconds: 1 } as const, notice: { id: 'n', en: 'x', zh: 'x', heard: null, undo: null } }
  assert.equal(pageKind(base), 'voice')
  assert.equal(pageKind({ ...base, voice: null }), 'notice')
  assert.equal(pageKind({ ...base, action: act }), 'confirm')
  assert.equal(pageKind({ ...real, voice: null, notice: null }), 'pnl')
})

test('voice: a long refusal wraps onto a second line instead of being cut', () => {
  const n = { id: 'n', en: 'Stop-loss 59,500 is above the BTC bid 58,000.12: it would fire at once. Not set.', zh: '止损 59,500 高于现在的买一价 58,000，会立刻触发，没设。语音不做开仓或加仓，只能减半 / 平仓 / 止损 / 止盈 / 提醒。', heard: 'x', undo: null }
  for (const lang of ['en', 'zh'] as const) {
    const p = noticePage(n, lang)
    assert.deepEqual(overflows(p), [])
    const joined = p.texts[0].content + (lang === 'en' ? ' ' : '') + p.texts[1].content
    const full = lang === 'zh' ? n.zh : n.en
    assert.ok(!p.texts[0].content.endsWith('…'), p.texts[0].content)
    assert.ok(joined.replace(/\s+/g, '').startsWith(full.replace(/\s+/g, '').slice(0, 40)), joined)
  }
})
