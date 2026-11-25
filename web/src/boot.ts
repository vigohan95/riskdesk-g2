// Browser demo boot: runs the real desk (server/src/desk.ts) inside this tab, answers the glasses app's HTTP / SSE
// calls to it in-process, and starts the unchanged glasses app (app/src/main.ts) against the lens.
//
// Same as the local backend: live Coinbase public WebSocket + candles, the paper ledger, confirm -> 5 s undo,
// paper stop / take orders watched against the live bid/ask, the voice parser and its refusals.
// Different, and said on the page: orders are booked as paper fills (the Coinbase sandbox does not allow browser
// calls), the demo portfolio lives in this browser's localStorage, and "voice" is typed text fed in as the transcript.

import { Lens } from './lens.ts'
import { startDesk, HttpError, type Desk, type Store } from '../../server/src/desk.ts'

// Recording.pcm() in the shared voice code uses Buffer.concat; that is all it needs here.
const g = globalThis as any
if (!g.Buffer) {
  g.Buffer = {
    concat(parts: Uint8Array[]) {
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
      let o = 0
      for (const p of parts) { out.set(p, o); o += p.length }
      return out
    },
  }
}

const SERVER = 'http://riskdesk.demo'
const KEY = 'riskdesk.demo.'
function store<T>(name: string, empty: T): Store<T> {
  return {
    load: () => { try { const v = localStorage.getItem(KEY + name); return v ? JSON.parse(v) : empty } catch { return empty } },
    save: (v) => { try { localStorage.setItem(KEY + name, JSON.stringify(v)) } catch { /* private window: keep in memory only */ } },
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const status = (s: string) => { $('status').textContent = s }

let resolveLens!: (l: Lens) => void
export const lensReady = new Promise<Lens>((r) => { resolveLens = r })

let typed = ''
let desk: Desk

async function boot() {
  const lens = new Lens($('lens'))
  status('Loading live Coinbase prices and pricing the demo fills at real history...')
  desk = await startDesk({
    products: ['BTC-USD', 'ETH-USD'],
    fills: store('fills', []),
    orders: store('orders', []),
    alerts: store('alerts', []),
    // The ActionDesk books the fill itself at the bid/ask at execution time; this only stands in for the exchange ack.
    placeOrder: async (req) => ({ ok: true, orderId: `paper-${req.client_order_id.slice(0, 8)}` }),
    venue: 'paper',
    transcribe: async () => ({ text: typed, stt_ms: 0 }),
    uuid: () => crypto.randomUUID(),
  })
  installServer(desk)
  resolveLens(lens)
  wireControls(lens)
  await import('../../app/src/main.ts')
  status('Live. Prices are the Coinbase public feed; orders are paper fills at the live bid/ask.')
}

// ---------- the backend's HTTP surface, in-process ----------
function installServer(d: Desk) {
  const realFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.startsWith(SERVER)) return realFetch(input as any, init)
    const u = new URL(url)
    const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } })
    try {
      if (u.pathname === '/api/state') return json(d.state())
      if (d.raw[u.pathname]) {
        const b = init?.body
        const bytes = b instanceof Uint8Array ? b : b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(0)
        return json(await d.raw[u.pathname](u.searchParams, bytes))
      }
      if (d.actions[u.pathname]) return json(await d.actions[u.pathname](init?.body ? JSON.parse(String(init.body)) : {}))
      return json({ error: 'not found' }, 404)
    } catch (e) {
      return json({ error: (e as Error).message }, e instanceof HttpError ? e.status : 400)
    }
  }
  const RealES = window.EventSource
  class DemoEventSource {
    onmessage: ((ev: { data: string }) => void) | null = null
    onerror: (() => void) | null = null
    constructor(url: string) {
      if (!String(url).startsWith(SERVER)) return new RealES(url) as any
      const send = (s: unknown) => this.onmessage?.({ data: JSON.stringify(s) })
      d.onPush(send)
      setTimeout(() => send(d.state()), 0)
    }
    close() {}
  }
  ;(window as any).EventSource = DemoEventSource
}

// ---------- buttons under the lens ----------
const SILENCE = new Uint8Array(3200) // 100 ms of 16 kHz s16le mono

function wireControls(lens: Lens) {
  const menuBtn = $<HTMLButtonElement>('b-menu')
  const syncMenu = () => { menuBtn.textContent = lens.menuOpen ? 'Close menu' : 'Menu'; $('menu-help').hidden = !lens.menuOpen }
  lens.onMenu = syncMenu
  $('b-tap').onclick = () => lens.tap()
  $('b-double').onclick = () => lens.doubleTap()
  $('b-up').onclick = () => lens.scroll(-1)
  $('b-down').onclick = () => lens.scroll(1)
  menuBtn.onclick = () => { if (lens.menuOpen) lens.closeMenu(); else if (!lens.openMenu()) status('The context menu exists only on the positions page (double tap / tap back to it).'); syncMenu() }
  $('lens').onclick = () => lens.tap()
  $('lens').ondblclick = (e) => { e.preventDefault(); lens.doubleTap() }

  const input = $<HTMLInputElement>('say')
  const sayBtn = $<HTMLButtonElement>('b-say')
  let saying = false
  async function say(text: string) {
    if (saying || !text.trim()) return
    saying = true
    sayBtn.disabled = true
    typed = text.trim()
    try {
      lens.longPress()
      // the app opens the mic once the backend has started a recording
      for (let i = 0; i < 40 && !lens.micOn; i++) await sleep(50)
      if (!lens.micOn) { status('Hold to talk works from the positions, risk or notice page.'); lens.release(); return }
      for (let i = 0; i < 6; i++) { lens.micChunk(SILENCE); await sleep(100) }
      await sleep(350) // the app posts audio every 300 ms
      lens.release()
    } finally {
      saying = false
      sayBtn.disabled = false
    }
  }
  sayBtn.onclick = () => void say(input.value)
  input.onkeydown = (e) => { if (e.key === 'Enter') void say(input.value) }

  // Example commands priced off the live market, so a stop is really below the bid when you try it.
  const ex = $('examples')
  const fill = () => {
    const s: any = desk.state()
    const btc = s.rows?.find((r: any) => r.sym === 'BTC')?.price
    const eth = s.rows?.find((r: any) => r.sym === 'ETH')?.price
    if (!btc || !eth) { setTimeout(fill, 1000); return }
    const r = (x: number, step: number) => Math.round(x / step) * step
    const list = [
      `BTC stop at ${r(btc * 0.97, 100)}, take profit at ${r(btc * 1.04, 100)}`,
      'Cut my ETH position in half',
      `Alert me if ETH drops below ${r(eth * 0.98, 10)}`,
      'Buy half an ETH',
      `比特币止损 ${r(btc * 0.96, 100)}`,
      `BTC stop at ${r(btc * 0.3, 100)}`,
    ]
    ex.replaceChildren(...list.map((t) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'chip'
      b.textContent = t
      b.onclick = () => { input.value = t; void say(t) }
      return b
    }))
  }
  fill()

  $('b-reset').onclick = () => {
    for (const k of Object.keys(localStorage)) if (k.startsWith(KEY)) localStorage.removeItem(k)
    location.reload()
  }
  document.addEventListener('keydown', (e) => {
    if (e.target === input) return
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); lens.tap() }
    else if (e.key === 'Backspace' || e.key === 'Escape') { e.preventDefault(); lens.doubleTap() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); lens.scroll(-1) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); lens.scroll(1) }
    else if (e.key === 'm') menuBtn.click()
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

boot().catch((e) => { console.error(e); status(`Could not start: ${(e as Error).message}`) })
