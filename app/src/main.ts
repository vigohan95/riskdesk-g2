// RiskDesk glasses app: live PnL page + one-tap actions (context menu -> confirm -> 5 s undo -> result)
// + hold-to-talk voice commands (long press -> mic on, PCM streamed to the backend; release -> transcribe -> the same confirm page).
// Data comes from the RiskDesk backend over Server-Sent Events; this file only renders and forwards taps.
// The server owns every number and every state transition; the glasses never compute money.
// Updates use textContainerUpgrade (no flicker, ~83 ms) and are serialized: bridge writes never overlap,
// and if several states arrive while a write is in flight only the newest is drawn.

import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  MenuContainerProperty,
  MenuItemProperty,
  OsEventTypeList,
  AudioInputSource,
  ImageContainerProperty,
  ImageRawDataUpdate,
} from '@evenrealities/even_hub_sdk'
import {
  pnlPage, confirmPage, undoPage, resultPage, voicePage, noticePage, pageKind, menuItems, menuAction, MENU_LANG, overflows, PAD,
  type DeskState, type Lang, type Page, type PageKind, type Text,
} from './layout.ts'
import { riskPage, chartPixels, chartKey, CHART, type RiskView } from './risk.ts'

const params = new URLSearchParams(location.search)
const SERVER = params.get('server') ?? localStorage.getItem('riskdesk.server') ?? import.meta.env.VITE_RISKDESK_SERVER ?? 'http://127.0.0.1:8787'
const SYMS = (params.get('syms') ?? 'BTC,ETH').split(',')
let lang: Lang = (params.get('lang') as Lang) ?? (localStorage.getItem('riskdesk.lang') as Lang) ?? 'en'

const toProp = (t: Text) =>
  new TextContainerProperty({
    xPosition: t.x, yPosition: t.y, width: t.w, height: t.h,
    borderWidth: t.border ? 1 : 0, borderColor: 5, borderRadius: t.border ? 4 : 0,
    paddingLength: PAD, containerID: t.id, containerName: t.name,
    content: t.content, textColor: t.color, isEventCapture: t.capture ? 1 : 0,
  })

const bridge = await waitForEvenAppBridge()
const menu = () => new MenuContainerProperty({ menuItems: menuItems(SYMS, lang).map((m) => new MenuItemProperty(m)) })
let shown: Page = pnlPage(null, lang)
let shownKind: PageKind = 'pnl'
let shownKey = 'pnl'
let shownLang: Lang = lang
await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({ containerTotalNum: shown.texts.length, textObject: shown.texts.map(toProp), menuObject: menu() }))
console.log('RISKDESK_READY', SERVER)

let latest: DeskState | null = null
let offline = false
/** A refusal that never became a server action (e.g. "no ETH position"), shown on the result page. */
let note: { text: string; until: number } | null = null
let busy = false
let dirty = false
/** Risk page open on state.risk[riskIdx] (null = positions page). Orders, voice and notices still take over. */
let riskIdx: number | null = null
let shownChart = ''
let chartSentAt = 0
/** Re-send the chart at most this often while the page stays open (every send costs ~100 ms and glasses memory). */
const CHART_MIN_MS = 15_000

/** 8-bit grey pixels -> PNG bytes via a canvas (the host converts PNG to 4-bit grey). */
function pngOf(v: RiskView): number[] {
  const c = document.createElement('canvas')
  c.width = CHART.w; c.height = CHART.h
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(CHART.w, CHART.h)
  const g = chartPixels(v)
  for (let k = 0; k < g.length; k++) { img.data[4 * k] = img.data[4 * k + 1] = img.data[4 * k + 2] = g[k]; img.data[4 * k + 3] = 255 }
  ctx.putImageData(img, 0, 0)
  const bin = atob(c.toDataURL('image/png').split(',')[1])
  return Array.from(bin, (ch) => ch.charCodeAt(0))
}
async function sendChart(v: RiskView) {
  const t0 = performance.now()
  const res = await bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: CHART.id, containerName: CHART.name, imageData: pngOf(v) }))
  shownChart = chartKey(v)
  chartSentAt = Date.now()
  console.log('CHART', v.sym, String(res), `${Math.round(performance.now() - t0)} ms`)
}

function wanted(): { kind: PageKind; page: Page; chart?: RiskView | null; key: string } {
  if (note && Date.now() < note.until) return { kind: 'result', page: resultPage(null, lang, note.text), key: 'result' }
  note = null
  const kind = pageKind(latest)
  const v = latest?.action ?? null
  if (kind === 'confirm') return { kind, page: confirmPage(v!, lang), key: kind }
  if (kind === 'undo') return { kind, page: undoPage(v!, lang), key: kind }
  if (kind === 'result') return { kind, page: resultPage(v, lang), key: kind }
  if (kind === 'voice') return { kind, page: voicePage(latest!.voice!, lang), key: kind }
  if (kind === 'notice') return { kind, page: noticePage(latest!.notice!, lang), key: kind }
  if (riskIdx !== null && !offline) {
    const risk = latest?.risk ?? []
    // A position closed while its page was open: fall back to the last one, or to "nothing at risk".
    if (riskIdx >= risk.length) riskIdx = Math.max(0, risk.length - 1)
    const page = riskPage(risk, riskIdx, lang)
    return { kind: 'risk', page, chart: page.chart, key: `risk:${page.chart?.product ?? 'none'}` }
  }
  return { kind, page: pnlPage(latest, lang, offline), key: kind }
}

async function draw() {
  if (busy) { dirty = true; return }
  busy = true
  try {
    do {
      dirty = false
      const { kind, page: next, chart, key } = wanted()
      const bad = overflows(next)
      if (bad.length) console.warn('LAYOUT_OVERFLOW', bad.join(' | '))
      if (key !== shownKey || (kind === 'pnl' && lang !== shownLang)) {
        // Different page (or the menu labels changed language): rebuild. Only the PnL page carries the menu,
        // so the menu cannot open on top of a confirm or undo page.
        await bridge.rebuildPageContainer(new RebuildPageContainer({
          containerTotalNum: next.texts.length + (chart ? 1 : 0),
          textObject: next.texts.map(toProp),
          ...(chart ? { imageObject: [new ImageContainerProperty({ xPosition: CHART.x, yPosition: CHART.y, width: CHART.w, height: CHART.h, containerID: CHART.id, containerName: CHART.name })] } : {}),
          ...(kind === 'pnl' ? { menuObject: menu() } : {}),
        }))
        console.log('PAGE', key, lang)
        // A rebuilt image container starts empty: draw the chart right away.
        if (chart) await sendChart(chart)
      } else {
        for (const t of next.texts) {
          const old = shown.texts.find((o) => o.id === t.id)
          if (old && old.content === t.content && old.color === t.color) continue
          await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: t.id, containerName: t.name, content: t.content, textColor: t.color }))
        }
        if (chart && chartKey(chart) !== shownChart && Date.now() - chartSentAt > CHART_MIN_MS) await sendChart(chart)
      }
      shown = next
      shownKind = kind
      shownKey = key
      shownLang = lang
    } while (dirty)
  } finally {
    busy = false
  }
}

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${SERVER}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const out = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`)
  return out
}
function refuse(e: unknown) {
  note = { text: (e as Error).message, until: Date.now() + 4000 }
  console.warn('REFUSED', note.text)
  void draw()
  setTimeout(() => void draw(), 4100)
}

// ---------- hold-to-talk ----------
// Long press opens the glasses mic; PCM (16 kHz s16le mono, 100 ms per event) is batched and posted in order
// to the backend every 300 ms; release closes the mic and asks the backend to transcribe. The backend decides
// everything after that (confirm page, alert, or a refusal), and the page follows its state.
let rec: { id: string | null; buf: Uint8Array[]; sending: Promise<void>; timer: number } | null = null
const toBytes = (pcm: unknown): Uint8Array => {
  if (pcm instanceof Uint8Array) return pcm
  if (Array.isArray(pcm)) return Uint8Array.from(pcm as number[])
  if (typeof pcm === 'string') return Uint8Array.from(atob(pcm), (c) => c.charCodeAt(0))
  return new Uint8Array(0)
}
function flush() {
  if (!rec || !rec.id || !rec.buf.length) return
  const r = rec
  const n = r.buf.reduce((a, b) => a + b.length, 0)
  const body = new Uint8Array(n)
  let o = 0
  for (const b of r.buf) { body.set(b, o); o += b.length }
  r.buf = []
  r.sending = r.sending.then(() => fetch(`${SERVER}/api/voice/chunk?id=${r.id}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body }).then(() => {}, () => {}))
}
async function startVoice() {
  if (rec) return
  rec = { id: null, buf: [], sending: Promise.resolve(), timer: 0 }
  const r = rec
  try {
    const out = await post('/api/voice/begin', { lang })
    r.id = out.id
    const ok = await bridge.audioControl(true, AudioInputSource.Glasses)
    console.log('VOICE_BEGIN', r.id, 'mic', ok)
    r.timer = window.setInterval(flush, 300)
  } catch (e) {
    rec = null
    refuse(e)
  }
}
async function stopVoice() {
  const r = rec
  if (!r) return
  await bridge.audioControl(false).catch(() => false)
  clearInterval(r.timer)
  // begin may still be in flight if the press was very short
  for (let i = 0; i < 20 && !r.id; i++) await new Promise((res) => setTimeout(res, 50))
  flush()
  await r.sending
  rec = null
  if (!r.id) return
  try {
    const out = await post('/api/voice/end', { id: r.id })
    console.log('VOICE_END', JSON.stringify({ ok: out.ok, heard: out.heard, cmd: out.cmd, kind: out.proposal?.kind, message: out.message }))
  } catch (e) {
    refuse(e)
  }
}

function connect() {
  const es = new EventSource(`${SERVER}/api/stream`)
  es.onmessage = (ev) => {
    latest = JSON.parse(ev.data)
    offline = false
    void draw()
  }
  es.onerror = () => {
    offline = true
    void draw() // EventSource retries by itself
  }
}
connect()

// Input:
//   PnL page     tap = risk page (one held product per page: 24 h chart with entry / stop / take, money at stop)
//   risk page    tap = next product, after the last one back to positions; double-tap = positions
//   PnL page     context menu -> Halve / Close / Stop-loss / Take-profit <sym>, Cancel all orders, or switch language;
//                double-tap also switches language
//   confirm page tap = confirm (arms the 5 s undo window), double-tap = back
//   undo page    tap = undo
//   result page  tap = back
//   PnL / notice long press = hold to talk (release to send); notice page tap = remove the alert just set, or back;
//   result / notice double-tap = back (an alert just set is kept)
bridge.onEvenHubEvent((e) => {
  if (e.audioEvent) { if (rec) rec.buf.push(toBytes(e.audioEvent.audioPcm)); return }
  const item = e.menuItemClickEvent?.itemID
  if (item !== undefined) {
    console.log('MENU', item)
    if (item === MENU_LANG) { toggleLang(); return }
    const a = menuAction(item, SYMS)
    if (a) post('/api/preview', a.sym ? { kind: a.kind, product: `${a.sym}-USD` } : { kind: a.kind }).catch(refuse)
    return
  }
  const type = e.textEvent?.eventType ?? e.sysEvent?.eventType
  const v = latest?.action
  const kind = shownKind
  // CLICK_EVENT is 0, the protobuf default, so it usually arrives with eventType omitted:
  // the simulator sends a click as {sysEvent: {eventSource: 1}} (seen 2026-11-23).
  const isClick = type === OsEventTypeList.CLICK_EVENT || (type === undefined && !!(e.textEvent || e.sysEvent))
  if (type === OsEventTypeList.LONG_PRESS_EVENT) {
    // Voice starts from the positions page or over a notice; never on top of a confirm / undo page.
    if (kind === 'pnl' || kind === 'notice' || kind === 'risk') void startVoice()
    return
  }
  if (type === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) { void stopVoice(); return }
  if (isClick) {
    if (kind === 'notice' && latest?.notice) {
      const n = latest.notice
      post(n.undo ? '/api/alerts/remove' : '/api/notice/dismiss', { id: n.undo ?? n.id }).catch(refuse)
      return
    }
    if (kind === 'confirm' && v) post('/api/confirm', { id: v.id }).catch(refuse)
    else if (kind === 'undo' && v && v.status === 'armed') post('/api/undo', { id: v.id }).catch(refuse)
    else if (kind === 'pnl' && latest?.risk?.length) { riskIdx = 0; void draw() }
    else if (kind === 'risk') { riskIdx = riskIdx !== null && riskIdx + 1 < (latest?.risk?.length ?? 0) ? riskIdx + 1 : null; void draw() }
    else if (kind === 'result') {
      if (note) { note = null; void draw() }
      else if (v) post('/api/dismiss', { id: v.id }).catch(refuse)
    }
  } else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    if (kind === 'confirm' && v) post('/api/undo', { id: v.id }).then(() => post('/api/dismiss', { id: v.id })).catch(refuse)
    else if (kind === 'pnl') toggleLang()
    else if (kind === 'risk') { riskIdx = null; void draw() }
    // double-tap = back everywhere else too: leave a result, or keep the alert a notice offers to remove
    else if (kind === 'result') {
      if (note) { note = null; void draw() }
      else if (v) post('/api/dismiss', { id: v.id }).catch(refuse)
    } else if (kind === 'notice' && latest?.notice) post('/api/notice/dismiss', { id: latest.notice.id }).catch(refuse)
  }
})

function toggleLang() {
  lang = lang === 'en' ? 'zh' : 'en'
  localStorage.setItem('riskdesk.lang', lang)
  void draw()
}
