// RiskDesk backend: live Coinbase quotes + local paper ledger -> small JSON state for the glasses.
//   GET /api/state   one snapshot
//   GET /api/stream  Server-Sent Events, at most one event per second (throttled by the feed)
// Binds to 127.0.0.1 by default (HOST / PORT env to change). No API keys needed.

import { createServer, type ServerResponse } from 'node:http'
import { TickerFeed } from './feed.ts'
import { utcDayStart } from './ledger.ts'
import { priceAt } from './candles.ts'
import { DEMO_SEED, resolveSeed, FillStore, buildLedger } from './portfolio.ts'
import { buildState } from './state.ts'

const PRODUCTS = (process.env.PRODUCTS ?? 'BTC-USD,ETH-USD').split(',')
const HOST = process.env.HOST ?? '127.0.0.1'
const PORT = Number(process.env.PORT ?? 8787)
const store = new FillStore(new URL('../data/fills.json', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'))

async function main() {
  let fills = store.load()
  if (!fills.length) {
    fills = await resolveSeed(DEMO_SEED, Date.now())
    store.save(fills)
    console.log(`seeded demo portfolio: ${fills.map((f) => `${f.side} ${f.qty} ${f.product} @ ${f.price}`).join('; ')}`)
  }
  const ledger = buildLedger(fills)

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
  const state = () => buildState(feed.snapshot(), ledger, PRODUCTS, dayStart, dayOpen, Date.now())
  feed.onUpdate(() => {
    const data = `data: ${JSON.stringify(state())}\n\n`
    for (const c of clients) c.write(data)
  })
  feed.start()

  createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    const path = (req.url ?? '/').split('?')[0]
    if (path === '/api/state') {
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

main().catch((e) => { console.error(e); process.exit(1) })
