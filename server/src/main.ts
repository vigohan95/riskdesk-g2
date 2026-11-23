// RiskDesk backend: live Coinbase quotes + local paper ledger -> small JSON state for the glasses.
//   GET  /api/state    one snapshot
//   GET  /api/stream   Server-Sent Events: on every price change (<= 1/s), every action change,
//                      and once per second of an undo countdown
//   POST /api/preview  {kind: 'halve'|'close'|'stop'|'take', product} or {kind: 'cancelAll'} -> priced proposal, nothing sent
//                      stop / take place a paper resting order (2% / 3% from the exit price, STOP_PCT / TAKE_PCT env);
//                      it fires one market order when the live bid/ask crosses it
//   POST /api/confirm  {id}  -> armed, order goes out after 5 s unless undone
//   POST /api/undo     {id}  -> cancelled inside the window (or a proposal dismissed)
//   POST /api/dismiss  {id}  -> clear a finished action from the glasses early
// Orders go to the public Coinbase Advanced Trade sandbox (ORDERS_BASE to change).
// Binds to 127.0.0.1 by default (HOST / PORT env to change). No API keys needed.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { TickerFeed } from './feed.ts'
import { utcDayStart } from './ledger.ts'
import { priceAt } from './candles.ts'
import { DEMO_SEED, resolveSeed, FillStore, JsonStore, buildLedger } from './portfolio.ts'
import { buildState } from './state.ts'
import { ActionDesk, coinbaseOrders, SANDBOX, ACTION_KINDS, type ActionKind, type ActionState } from './actions.ts'
import { PaperOrderBook, STOP_PCT, TAKE_PCT, type Resting } from './orders.ts'

const PRODUCTS = (process.env.PRODUCTS ?? 'BTC-USD,ETH-USD').split(',')
const HOST = process.env.HOST ?? '127.0.0.1'
const PORT = Number(process.env.PORT ?? 8787)
/** How long a finished action (filled / undone / failed) stays on the glasses before the PnL page returns. */
const RESULT_MS = 4000
const dataFile = (name: string) => new URL(`../data/${name}`, import.meta.url).pathname.replace(/^\/(\w:)/, '$1')
const orderStore = new JsonStore<Resting[]>(dataFile('orders.json'), [])
const store = new FillStore(dataFile('fills.json'))

async function main() {
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
  const clients = new Set<ServerResponse>()
  let current: ActionState | null = null
  let finishedAt = 0
  const visible = () => (current && isFinal(current) && Date.now() - finishedAt > RESULT_MS ? null : current)
  const state = () => buildState(feed.snapshot(), ledger, PRODUCTS, dayStart, dayOpen, Date.now(), { book, action: visible(), venue: (process.env.ORDERS_BASE ?? SANDBOX) === SANDBOX ? 'sandbox' : 'production' })
  const push = () => {
    const data = `data: ${JSON.stringify(state())}

`
    for (const c of clients) c.write(data)
  }
  const desk = new ActionDesk({
    ledger,
    book,
    stopPct: Number(process.env.STOP_PCT ?? STOP_PCT),
    takePct: Number(process.env.TAKE_PCT ?? TAKE_PCT),
    quote: (p) => { const t = feed.snapshot().ticks[p]; return t && feed.snapshot().status === 'live' ? { bid: t.bid, ask: t.ask } : null },
    placeOrder: coinbaseOrders(process.env.ORDERS_BASE ?? SANDBOX),
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
    push()
  })
  feed.start()

  const actions: Record<string, (b: any) => unknown> = {
    '/api/preview': (b) => {
      if (current && (current.status === 'armed' || current.status === 'sending')) throw new HttpError(409, 'another action is about to execute')
      if (current?.status === 'proposed') desk.undo(current.p.id)
      if (!ACTION_KINDS.includes(b.kind)) throw new HttpError(400, `kind must be one of ${ACTION_KINDS.join(', ')}`)
      return desk.preview(b.kind as ActionKind, String(b.product ?? '*'))
    },
    '/api/confirm': (b) => desk.confirm(String(b.id)),
    '/api/undo': (b) => desk.undo(String(b.id)),
    '/api/dismiss': (b) => {
      if (current && current.p.id === b.id && isFinal(current)) { finishedAt = 0; push() }
      return { ok: true }
    },
  }

  createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    const path = (req.url ?? '/').split('?')[0]
    if (req.method === 'OPTIONS') {
      res.end()
    } else if (req.method === 'POST' && actions[path]) {
      res.setHeader('Content-Type', 'application/json')
      try {
        const out = actions[path](await readJson(req))
        res.end(JSON.stringify(out))
      } catch (e) {
        res.statusCode = e instanceof HttpError ? e.status : 400
        res.end(JSON.stringify({ error: (e as Error).message }))
        // A refused preview still has to reach the glasses, which are waiting for a page.
        if (path === '/api/preview') console.log(`preview refused: ${(e as Error).message}`)
      }
    } else if (path === '/api/state') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(state()))
    } else if (path === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      res.write(`data: ${JSON.stringify(state())}\n\n`)
      clients.add(res)
      req.on('close', () => clients.delete(res))
    } else {
      res.statusCode = 404
      res.end('not found')
    }
  }).listen(PORT, HOST, () => console.log(`riskdesk server on http://${HOST}:${PORT}`))
}

class HttpError extends Error {
  status: number
  constructor(status: number, msg: string) { super(msg); this.status = status }
}
const isFinal = (s: ActionState) => s.status === 'filled' || s.status === 'placed' || s.status === 'undone' || s.status === 'failed'
function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 10_000) req.destroy() })
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}) } catch { reject(new HttpError(400, 'bad JSON')) } })
    req.on('error', reject)
  })
}

main().catch((e) => { console.error(e); process.exit(1) })
