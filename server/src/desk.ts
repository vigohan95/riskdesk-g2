// The RiskDesk desk: live Coinbase feed + paper ledger + actions + voice, wired together, with no I/O of its own.
// main.ts serves it over HTTP / SSE from Node; web/ runs the very same desk inside a browser tab for the
// no-install demo. Everything that touches disk, the network for orders, or speech-to-text is injected.

import { TickerFeed } from './feed.ts'
import { utcDayStart } from './ledger.ts'
import { priceAt } from './candles.ts'
import { DEMO_SEED, resolveSeed, buildLedger } from './portfolio.ts'
import { buildState } from './state.ts'
import { SeriesCache } from './risk.ts'
import { ActionDesk, ACTION_KINDS, type ActionKind, type ActionState, type PlaceOrder } from './actions.ts'
import { PaperOrderBook, STOP_PCT, TAKE_PCT, type Resting } from './orders.ts'
import { PriceAlerts, type Alert } from './alerts.ts'
import { Recording, understand, wavChunks, MIN_AUDIO_S, type Market } from './voice.ts'
import type { Notice, VoiceView } from './state.ts'
import type { Fill } from './ledger.ts'

export type Store<T> = { load(): T; save(v: T): void }
export type DeskDeps = {
  products: string[]
  fills: Store<Fill[]>
  orders: Store<Resting[]>
  alerts: Store<Alert[]>
  placeOrder: PlaceOrder
  venue: 'sandbox' | 'production' | 'paper'
  transcribe: (pcm: Uint8Array, lang: 'en' | 'zh') => Promise<{ text: string; stt_ms: number }>
  stopPct?: number
  takePct?: number
  devInject?: boolean
  uuid: () => string
}
export type Desk = {
  state: () => unknown
  onPush: (fn: (state: unknown) => void) => void
  actions: Record<string, (b: any) => unknown>
  raw: Record<string, (q: URLSearchParams, body: Uint8Array) => unknown>
}

/** How long a finished action (filled / undone / failed) stays on the glasses before the PnL page returns. */
const RESULT_MS = 4000
const NOTICE_MS = 5000
const fmtPx = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: x < 100 ? 2 : 0 })

export async function startDesk(d: DeskDeps): Promise<Desk> {
  const PRODUCTS = d.products
  const store = d.fills, orderStore = d.orders, alertStore = d.alerts
  const randomUUID = d.uuid
  const transcribe = d.transcribe
  const DEV_INJECT = !!d.devInject
  const listeners: ((s: unknown) => void)[] = []
  let fills = store.load()
  if (!fills.length) {
    fills = await resolveSeed(DEMO_SEED, Date.now())
    store.save(fills)
    console.log(`seeded demo portfolio: ${fills.map((f) => `${f.side} ${f.qty} ${f.product} @ ${f.price}`).join('; ')}`)
  }
  const ledger = buildLedger(fills)
  const book = new PaperOrderBook(orderStore.load())
  for (const p of new Set(book.list().map((o) => o.product))) book.reconcile(p, ledger.qty(p))
  const saveBook = () => orderStore.save(book.list())

  let dayStart = utcDayStart(Date.now())
  let dayOpen: Record<string, number> = {}
  async function refreshDayOpen() {
    dayStart = utcDayStart(Date.now())
    const next: Record<string, number> = {}
    for (const p of new Set([...PRODUCTS, ...ledger.products()])) next[p] = await priceAt(p, dayStart)
    dayOpen = next
    console.log(`day open ${new Date(dayStart).toISOString()}: ${JSON.stringify(dayOpen)}`)
  }
  await refreshDayOpen()
  setInterval(() => { if (utcDayStart(Date.now()) !== dayStart) refreshDayOpen().catch((e) => console.error(e)) }, 60_000)

  const feed = new TickerFeed({ products: PRODUCTS })
  // 24 h chart for the risk page: public 15-minute candles, refreshed every 5 min for held products.
  const series = new SeriesCache()
  const refreshSeries = () => Promise.all(ledger.products().filter((p) => PRODUCTS.includes(p)).map((p) => series.refresh(p, Date.now())))
  await refreshSeries()
  setInterval(() => { void refreshSeries() }, 60_000)
  let current: ActionState | null = null
  let finishedAt = 0
  const visible = () => (current && isFinal(current) && Date.now() - finishedAt > RESULT_MS ? null : current)
  const alerts = new PriceAlerts(alertStore.load())
  let rec: Recording | null = null
  let thinking: VoiceView | null = null
  let notice: (Notice & { until: number }) | null = null
  const voiceView = (): VoiceView | null => thinking ?? (rec ? { status: 'listening', lang: rec.lang, seconds: Math.round(rec.seconds * 10) / 10 } : null)
  const liveNotice = () => (notice && Date.now() < notice.until ? { id: notice.id, en: notice.en, zh: notice.zh, heard: notice.heard, undo: notice.undo } : null)
  const state = () => buildState(feed.snapshot(), ledger, PRODUCTS, dayStart, dayOpen, Date.now(), {
    book, action: visible(), venue: d.venue,
    alerts: alerts.size, voice: voiceView(), notice: liveNotice(), series: (p) => series.get(p),
  })
  const showNotice = (en: string, zh: string, heard: string | null, undo: string | null = null) => {
    notice = { id: randomUUID(), en, zh, heard, undo, until: Date.now() + NOTICE_MS }
    setTimeout(() => push(), NOTICE_MS + 50)
  }
  const push = () => {
    const s = state()
    for (const fn of listeners) fn(s)
  }
  const desk = new ActionDesk({
    ledger,
    book,
    stopPct: d.stopPct ?? STOP_PCT,
    takePct: d.takePct ?? TAKE_PCT,
    quote: (p) => { const t = feed.snapshot().ticks[p]; return t && feed.snapshot().status === 'live' ? { bid: t.bid, ask: t.ask } : null },
    placeOrder: d.placeOrder,
    onFill: (f) => { store.save(ledger.fills); console.log(`filled ${f.side} ${f.qty} ${f.product} @ ${f.price}`) },
    onChange: (s) => {
      if (s.status === 'placed' || s.status === 'filled') saveBook()
      // A resting order that fires while the user looks at a confirm / undo page is logged and booked but
      // does not replace that page; the PnL page and the footer count show it once the page closes.
      if (current && current.p.id !== s.p.id && !isFinal(current)) { console.log(`action ${s.p.id.slice(0, 8)} ${s.p.kind} ${s.p.product}: ${s.status} (behind the open page)`); push(); return }
      current = s
      if (isFinal(s)) { finishedAt = Date.now(); setTimeout(push, RESULT_MS + 50) }
      console.log(`action ${s.p.id.slice(0, 8)} ${s.p.kind} ${s.p.product}: ${s.status}${s.status === 'failed' ? ` (${s.reason})` : ''}`)
      push()
    },
  })
  // Undo countdown: one push per displayed second.
  let lastSec = -1
  setInterval(() => {
    if (current?.status !== 'armed') { lastSec = -1; return }
    const sec = Math.ceil((current.fireAt - Date.now()) / 1000)
    if (sec !== lastSec) { lastSec = sec; push() }
  }, 100)
  feed.onUpdate(() => {
    for (const p of new Set(book.list().map((o) => o.product))) void desk.onQuote(p)
    const snap = feed.snapshot()
    if (snap.status === 'live' && alerts.size) {
      for (const p of new Set(alerts.list().map((a) => a.product))) {
        const t = snap.ticks[p]
        if (!t) continue
        const hit = alerts.check(p, t.price)
        for (const a of hit) {
          const sym = p.replace(/-USD$/, '')
          console.log(`alert hit ${sym} ${a.dir} ${a.price} at ${t.price}`)
          showNotice(`Alert: ${sym} ${a.dir === 'below' ? 'fell below' : 'rose above'} ${fmtPx(a.price)} (now ${fmtPx(t.price)})`,
            `提醒：${sym} ${a.dir === 'below' ? '跌破' : '涨破'} ${fmtPx(a.price)}（现价 ${fmtPx(t.price)}）`, null)
        }
        if (hit.length) alertStore.save(alerts.list())
      }
    }
    push()
  })
  const market: Market = {
    price: (p) => { const s = feed.snapshot(); return s.status === 'live' ? s.ticks[p]?.price ?? null : null },
    exit: (p) => { const s = feed.snapshot(); const t = s.ticks[p]; if (!t || s.status !== 'live') return null; return ledger.qty(p) < 0 ? t.ask : t.bid },
    held: (p) => ledger.qty(p),
  }
  const busyAction = () => !!current && (current.status === 'armed' || current.status === 'sending')
  const preview = (kind: ActionKind, product: string, opts = {}) => {
    if (busyAction()) throw new HttpError(409, 'another action is about to execute')
    if (current?.status === 'proposed') desk.undo(current.p.id)
    return desk.preview(kind, product, opts)
  }
  const openRec = (id: string) => {
    if (!rec || rec.id !== id) throw new HttpError(404, 'no such recording (released already?)')
    return rec
  }
  let lastVoicePush = 0
  const raw: Desk['raw'] = {
    '/api/voice/chunk': (q, body) => {
      const r = openRec(String(q.get('id')))
      r.push(body)
      if (Date.now() - lastVoicePush > 500) { lastVoicePush = Date.now(); push() }
      return { ok: true, seconds: r.seconds }
    },
  }
  if (DEV_INJECT) {
    raw['/api/dev/inject'] = (q, body) => {
      const r = openRec(String(q.get('id') ?? rec?.id))
      const chunks = wavChunks(body)
      for (const c of chunks) r.push(c)
      push()
      console.log(`dev inject: ${chunks.length} chunks, ${r.seconds.toFixed(2)} s into ${r.id.slice(0, 8)}`)
      return { ok: true, id: r.id, chunks: chunks.length, seconds: r.seconds }
    }
  }
  feed.start()

  const actions: Record<string, (b: any) => unknown> = {
    '/api/preview': (b) => {
      if (!ACTION_KINDS.includes(b.kind)) throw new HttpError(400, `kind must be one of ${ACTION_KINDS.join(', ')}`)
      return preview(b.kind as ActionKind, String(b.product ?? '*'))
    },
    '/api/voice/begin': (b) => {
      if (busyAction()) throw new HttpError(409, 'another action is about to execute')
      if (thinking) throw new HttpError(409, 'still transcribing the last command')
      rec = new Recording(randomUUID(), b.lang === 'zh' ? 'zh' : 'en', Date.now())
      notice = null
      console.log(`voice begin ${rec.id.slice(0, 8)} ${rec.lang}`)
      push()
      return { id: rec.id }
    },
    '/api/alerts/remove': (b) => {
      const ok = alerts.remove(String(b.id))
      if (ok) alertStore.save(alerts.list())
      if (notice?.undo === b.id) notice = null
      push()
      return { ok }
    },
    '/api/notice/dismiss': (b) => { if (notice?.id === b.id) { notice = null; push() } return { ok: true } },
    '/api/voice/cancel': (b) => { if (rec && rec.id === b.id) { rec = null; push() } return { ok: true } },
    '/api/voice/end': async (b) => {
      const r = openRec(String(b.id))
      rec = null
      const lang = r.lang
      const say = (en: string, zh: string, heard: string | null, extra: object = {}, undo: string | null = null) => {
        showNotice(en, zh, heard, undo)
        push()
        return { ok: false, heard, message: lang === 'zh' ? zh : en, ...extra }
      }
      if (r.seconds < MIN_AUDIO_S) return say('Too short. Hold, speak, then release.', '太短了。按住说完再松开。', null)
      thinking = { status: 'thinking', lang, seconds: Math.round(r.seconds * 10) / 10 }
      push()
      let text: string, sttMs: number
      try {
        const out = await transcribe(r.pcm(), lang)
        text = out.text; sttMs = out.stt_ms
      } catch (e) {
        thinking = null
        return say(`Speech service: ${(e as Error).message}`, `语音服务：${(e as Error).message}`, null)
      }
      thinking = null
      const { cmd, plan } = understand(text, lang, market)
      console.log(`voice ${lang} ${r.seconds.toFixed(1)}s stt ${sttMs}ms "${text}" -> ${JSON.stringify(cmd)} -> ${plan.type}`)
      if (!text) return say('Heard nothing. Hold and speak again.', '没听到声音，请按住再说。', '')
      if (plan.type === 'refuse') return say(plan.en, plan.zh, text, { cmd })
      if (plan.type === 'alert') {
        const sym = plan.product.replace(/-USD$/, '')
        const id = randomUUID()
        const old = alerts.set({ id, product: plan.product, dir: plan.dir, price: plan.price, createdAt: Date.now() })
        alertStore.save(alerts.list())
        const rp = old ? [` (replaces ${fmtPx(old.price)})`, `（替换原来的 ${fmtPx(old.price)}）`] : ['', '']
        const warn = plan.far ? [' · over 20% away', ' · 离现价超过 20%'] : ['', '']
        return { ...say(`Alert set: ${sym} ${plan.dir} ${fmtPx(plan.price)}${rp[0]}${warn[0]}`, `已设提醒：${sym} ${plan.dir === 'below' ? '跌破' : '涨破'} ${fmtPx(plan.price)}${rp[1]}${warn[1]}`, text, { cmd }, id), ok: true }
      }
      try {
        const p = preview(plan.kind, plan.product, { trigger: plan.trigger, take: plan.kind === 'bracket' ? plan.take : null, heard: text, far: plan.far })
        return { ok: true, heard: text, cmd, proposal: p }
      } catch (e) {
        return say(`Not possible: ${(e as Error).message}`, `做不了：${(e as Error).message}`, text, { cmd })
      }
    },
    '/api/confirm': (b) => desk.confirm(String(b.id)),
    '/api/undo': (b) => desk.undo(String(b.id)),
    '/api/dismiss': (b) => {
      if (current && current.p.id === b.id && isFinal(current)) { finishedAt = 0; push() }
      return { ok: true }
    },
  }
  return { state, onPush: (fn) => { listeners.push(fn) }, actions, raw }
}

export class HttpError extends Error {
  status: number
  constructor(status: number, msg: string) { super(msg); this.status = status }
}
const isFinal = (s: ActionState) => s.status === 'filled' || s.status === 'placed' || s.status === 'undone' || s.status === 'failed'
