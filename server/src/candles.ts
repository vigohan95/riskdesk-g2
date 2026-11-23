// Historical prices from Coinbase's public candles endpoint (no key).
// Used for (1) the 00:00 UTC open that day PnL is measured from, and
// (2) pricing the demo portfolio's seed fills at what the market really traded at that time.

export const REST = 'https://api.exchange.coinbase.com'

export type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>

/** Open price of the 1-minute candle that contains time `t` (ms). */
export async function priceAt(product: string, t: number, fetchFn: Fetch = fetch as any): Promise<number> {
  const start = new Date(Math.floor(t / 60000) * 60000)
  const end = new Date(start.getTime() + 5 * 60000)
  const url = `${REST}/products/${product}/candles?granularity=60&start=${start.toISOString()}&end=${end.toISOString()}`
  const res = await fetchFn(url)
  if (!res.ok) throw new Error(`candles ${product} HTTP ${res.status}`)
  const rows: number[][] = await res.json()
  // rows: [time(s), low, high, open, close, volume], newest first
  const sorted = rows.slice().sort((a, b) => a[0] - b[0])
  const hit = sorted.find((r) => r[0] * 1000 >= start.getTime()) ?? sorted[0]
  if (!hit) throw new Error(`no candle for ${product} at ${start.toISOString()}`)
  return hit[3]
}
