// RiskDesk backend: live Coinbase quotes + local paper ledger -> small JSON state for the glasses.
//   GET  /api/state    one snapshot (includes `risk`: per held product, stop / take distance and money at
//                      each, 24 h range and a 15-minute close series for the chart)
//   GET  /api/stream   Server-Sent Events: on every price change (<= 1/s), every action change,
//                      and once per second of an undo countdown
//   POST /api/preview  {kind: 'halve'|'close'|'stop'|'take', product} or {kind: 'cancelAll'} -> priced proposal, nothing sent
//                      stop / take place a paper resting order (2% / 3% from the exit price, STOP_PCT / TAKE_PCT env);
//                      it fires one market order when the live bid/ask crosses it
//   POST /api/confirm  {id}  -> armed, order goes out after 5 s unless undone
//   POST /api/undo     {id}  -> cancelled inside the window (or a proposal dismissed)
//   POST /api/dismiss  {id}  -> clear a finished action from the glasses early
//   POST /api/voice/begin {lang}            hold-to-talk pressed -> {id}; the glasses show "listening"
//   POST /api/voice/chunk?id=  raw PCM       16 kHz s16le mono, as the G2 mic delivers it (<= 64 KB per call)
//   POST /api/voice/end   {id}               released -> local STT -> parser -> confirm page / alert / refusal
//   POST /api/voice/cancel {id}
//   POST /api/dev/inject?id=  WAV body       DEV_INJECT=1 only: feeds a recorded WAV into the open recording in
//                                            3200-byte chunks (the simulator has no microphone)
// Speech goes to the local stt/ service (STT_URL, default http://127.0.0.1:8788); audio never leaves the machine.
// Orders go to the public Coinbase Advanced Trade sandbox (ORDERS_BASE to change).
// Binds to 127.0.0.1 by default (HOST / PORT env to change). No API keys needed.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { FillStore, JsonStore } from './portfolio.ts'
import { coinbaseOrders, SANDBOX } from './actions.ts'
import type { Resting } from './orders.ts'
import type { Alert } from './alerts.ts'
import { sttClient } from './voice.ts'
import { startDesk, HttpError } from './desk.ts'

const PRODUCTS = (process.env.PRODUCTS ?? 'BTC-USD,ETH-USD').split(',')
const HOST = process.env.HOST ?? '127.0.0.1'
const PORT = Number(process.env.PORT ?? 8787)
const dataFile = (name: string) => new URL(`../data/${name}`, import.meta.url).pathname.replace(/^\/(\w:)/, '$1')
const ORDERS_BASE = process.env.ORDERS_BASE ?? SANDBOX

async function main() {
  const desk = await startDesk({
    products: PRODUCTS,
    fills: new FillStore(dataFile('fills.json')),
    orders: new JsonStore<Resting[]>(dataFile('orders.json'), []),
    alerts: new JsonStore<Alert[]>(dataFile('alerts.json'), []),
    placeOrder: coinbaseOrders(ORDERS_BASE),
    venue: ORDERS_BASE === SANDBOX ? 'sandbox' : 'production',
    transcribe: sttClient(process.env.STT_URL ?? 'http://127.0.0.1:8788') as any,
    stopPct: process.env.STOP_PCT ? Number(process.env.STOP_PCT) : undefined,
    takePct: process.env.TAKE_PCT ? Number(process.env.TAKE_PCT) : undefined,
    devInject: process.env.DEV_INJECT === '1',
    uuid: randomUUID,
  })
  const { actions, raw, state } = desk
  const clients = new Set<ServerResponse>()
  desk.onPush((s) => {
    const data = `data: ${JSON.stringify(s)}

`
    for (const c of clients) c.write(data)
  })

  createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    const path = (req.url ?? '/').split('?')[0]
    if (req.method === 'OPTIONS') {
      res.end()
    } else if (req.method === 'POST' && raw[path]) {
      res.setHeader('Content-Type', 'application/json')
      try {
        const q = new URLSearchParams((req.url ?? '').split('?')[1] ?? '')
        res.end(JSON.stringify(raw[path](q, await readRaw(req, path === '/api/dev/inject' ? 2_000_000 : 64_000))))
      } catch (e) {
        res.statusCode = e instanceof HttpError ? e.status : 400
        res.end(JSON.stringify({ error: (e as Error).message }))
      }
    } else if (req.method === 'POST' && actions[path]) {
      res.setHeader('Content-Type', 'application/json')
      try {
        const out = await actions[path](await readJson(req))
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

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 10_000) req.destroy() })
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}) } catch { reject(new HttpError(400, 'bad JSON')) } })
    req.on('error', reject)
  })
}

function readRaw(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    let n = 0
    req.on('data', (c: Buffer) => { n += c.length; if (n > max) { reject(new HttpError(413, 'body too large')); req.destroy() } else parts.push(c) })
    req.on('end', () => resolve(Buffer.concat(parts)))
    req.on('error', reject)
  })
}

main().catch((e) => { console.error(e); process.exit(1) })
