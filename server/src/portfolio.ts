// Demo portfolio: a few paper fills priced at the REAL historical Coinbase price of the time they
// claim to happen (resolved from public candles at startup), so nothing on screen is invented.
// Fills placed from the glasses are appended to data/fills.json and replayed on restart.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { PaperLedger, type Fill, type Side } from './ledger.ts'
import { priceAt, type Fetch } from './candles.ts'

export type SeedFill = { product: string; side: Side; qty: number; hoursAgo: number }

export const DEMO_SEED: SeedFill[] = [
  { product: 'BTC-USD', side: 'BUY', qty: 0.02, hoursAgo: 70 },
  { product: 'ETH-USD', side: 'BUY', qty: 0.5, hoursAgo: 30 },
  { product: 'ETH-USD', side: 'BUY', qty: 0.25, hoursAgo: 6 },
]

/** Seed times are rounded to the hour so the same seed resolves to the same fills within an hour. */
export async function resolveSeed(seed: SeedFill[], now: number, fetchFn?: Fetch): Promise<Fill[]> {
  const hour = Math.floor(now / 3600_000) * 3600_000
  const out: Fill[] = []
  for (const s of seed) {
    const t = hour - s.hoursAgo * 3600_000
    const price = await priceAt(s.product, t, fetchFn)
    out.push({ id: `seed-${s.product}-${t}`, product: s.product, side: s.side, qty: s.qty, price, t })
  }
  return out.sort((a, b) => a.t - b.t)
}

export class FillStore {
  readonly path: string
  constructor(path: string) { this.path = path }
  load(): Fill[] {
    if (!existsSync(this.path)) return []
    return JSON.parse(readFileSync(this.path, 'utf8'))
  }
  save(fills: Fill[]) {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(fills, null, 1))
  }
}

export class JsonStore<T> {
  readonly path: string
  private empty: T
  constructor(path: string, empty: T) { this.path = path; this.empty = empty }
  load(): T { return existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : this.empty }
  save(v: T) {
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, JSON.stringify(v, null, 1))
  }
}

export function buildLedger(fills: Fill[], feeRate?: number): PaperLedger {
  const L = new PaperLedger(feeRate)
  for (const f of fills.slice().sort((a, b) => a.t - b.t)) L.apply(f)
  return L
}
