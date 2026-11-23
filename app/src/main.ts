// RiskDesk glasses app: live PnL page + one-tap actions (context menu -> confirm -> 5 s undo -> result).
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
} from '@evenrealities/even_hub_sdk'
import {
  pnlPage, confirmPage, undoPage, resultPage, pageKind, menuItems, menuAction, MENU_LANG, overflows, PAD,
  type DeskState, type Lang, type Page, type PageKind, type Text,
} from './layout.ts'

const params = new URLSearchParams(location.search)
const SERVER = params.get('server') ?? localStorage.getItem('riskdesk.server') ?? 'http://127.0.0.1:8787'
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
let shownLang: Lang = lang
await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({ containerTotalNum: shown.texts.length, textObject: shown.texts.map(toProp), menuObject: menu() }))
console.log('RISKDESK_READY', SERVER)

let latest: DeskState | null = null
let offline = false
/** A refusal that never became a server action (e.g. "no ETH position"), shown on the result page. */
let note: { text: string; until: number } | null = null
let busy = false
let dirty = false

function wanted(): { kind: PageKind; page: Page } {
  if (note && Date.now() < note.until) return { kind: 'result', page: resultPage(null, lang, note.text) }
  note = null
  const kind = pageKind(latest)
  const v = latest?.action ?? null
  if (kind === 'confirm') return { kind, page: confirmPage(v!, lang) }
  if (kind === 'undo') return { kind, page: undoPage(v!, lang) }
  if (kind === 'result') return { kind, page: resultPage(v, lang) }
  return { kind, page: pnlPage(latest, lang, offline) }
}

async function draw() {
  if (busy) { dirty = true; return }
  busy = true
  try {
    do {
      dirty = false
      const { kind, page: next } = wanted()
      const bad = overflows(next)
      if (bad.length) console.warn('LAYOUT_OVERFLOW', bad.join(' | '))
      if (kind !== shownKind || (kind === 'pnl' && lang !== shownLang)) {
        // Different page (or the menu labels changed language): rebuild. Only the PnL page carries the menu,
        // so the menu cannot open on top of a confirm or undo page.
        await bridge.rebuildPageContainer(new RebuildPageContainer({
          containerTotalNum: next.texts.length,
          textObject: next.texts.map(toProp),
          ...(kind === 'pnl' ? { menuObject: menu() } : {}),
        }))
        console.log('PAGE', kind, lang)
      } else {
        for (const t of next.texts) {
          const old = shown.texts.find((o) => o.id === t.id)
          if (old && old.content === t.content && old.color === t.color) continue
          await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: t.id, containerName: t.name, content: t.content, textColor: t.color }))
        }
      }
      shown = next
      shownKind = kind
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
//   PnL page     context menu -> Halve / Close / Stop-loss / Take-profit <sym>, Cancel all orders, or switch language;
//                double-tap also switches language
//   confirm page tap = confirm (arms the 5 s undo window), double-tap = back
//   undo page    tap = undo
//   result page  tap = back
bridge.onEvenHubEvent((e) => {
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
  if (isClick) {
    if (kind === 'confirm' && v) post('/api/confirm', { id: v.id }).catch(refuse)
    else if (kind === 'undo' && v && v.status === 'armed') post('/api/undo', { id: v.id }).catch(refuse)
    else if (kind === 'result') {
      if (note) { note = null; void draw() }
      else if (v) post('/api/dismiss', { id: v.id }).catch(refuse)
    }
  } else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    if (kind === 'confirm' && v) post('/api/undo', { id: v.id }).then(() => post('/api/dismiss', { id: v.id })).catch(refuse)
    else if (kind === 'pnl') toggleLang()
  }
})

function toggleLang() {
  lang = lang === 'en' ? 'zh' : 'en'
  localStorage.setItem('riskdesk.lang', lang)
  void draw()
}
