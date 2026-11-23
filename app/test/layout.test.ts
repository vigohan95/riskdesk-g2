import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getTextWidth } from '@evenrealities/pretext'
import { pnlPage, overflows, rpad, fmtNum, signed, type DeskState } from '../src/layout.ts'

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

test('rpad lands within 1 px of the target width', () => {
  for (const s of ['61,240', '1,719.9', '+2.8%', '−0.1%', '0.020  −16.63']) {
    const out = rpad(s, 150)
    assert.ok(Math.abs(getTextWidth(out) - 150) <= 1, `${s}: ${getTextWidth(out)}`)
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
