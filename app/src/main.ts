// RiskDesk glasses app (Day 1: live PnL page).
// Data comes from the RiskDesk backend over Server-Sent Events; this file only renders.
// Updates use textContainerUpgrade (no flicker, ~83 ms) and are serialized: bridge writes never overlap,
// and if several states arrive while a write is in flight only the newest is drawn.

import {
  waitForEvenAppBridge,
  TextContainerProperty,
  TextContainerUpgrade,
  CreateStartUpPageContainer,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'
import { pnlPage, overflows, PAD, type DeskState, type Lang, type Page, type Text } from './layout.ts'

const params = new URLSearchParams(location.search)
const SERVER = params.get('server') ?? localStorage.getItem('riskdesk.server') ?? 'http://127.0.0.1:8787'
let lang: Lang = (params.get('lang') as Lang) ?? (localStorage.getItem('riskdesk.lang') as Lang) ?? 'en'

const toProp = (t: Text) =>
  new TextContainerProperty({
    xPosition: t.x, yPosition: t.y, width: t.w, height: t.h,
    borderWidth: t.border ? 1 : 0, borderColor: 5, borderRadius: t.border ? 4 : 0,
    paddingLength: PAD, containerID: t.id, containerName: t.name,
    content: t.content, textColor: t.color, isEventCapture: t.capture ? 1 : 0,
  })

const bridge = await waitForEvenAppBridge()
let shown: Page = pnlPage(null, lang)
await bridge.createStartUpPageContainer(new CreateStartUpPageContainer({ containerTotalNum: shown.texts.length, textObject: shown.texts.map(toProp) }))
console.log('RISKDESK_READY', SERVER)

let latest: DeskState | null = null
let offline = false
let busy = false
let dirty = false

async function draw() {
  if (busy) { dirty = true; return }
  busy = true
  try {
    do {
      dirty = false
      const next = pnlPage(latest, lang, offline)
      const bad = overflows(next)
      if (bad.length) console.warn('LAYOUT_OVERFLOW', bad.join(' | '))
      for (const t of next.texts) {
        const old = shown.texts.find((o) => o.id === t.id)
        if (old && old.content === t.content && old.color === t.color) continue
        await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: t.id, containerName: t.name, content: t.content, textColor: t.color }))
      }
      shown = next
    } while (dirty)
  } finally {
    busy = false
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

// Day 1 input: double-tap toggles English / Chinese. (Actions arrive on Day 2 via the context menu.)
bridge.onEvenHubEvent((e) => {
  const type = e.textEvent?.eventType ?? e.sysEvent?.eventType
  if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    lang = lang === 'en' ? 'zh' : 'en'
    localStorage.setItem('riskdesk.lang', lang)
    void draw()
  }
})
