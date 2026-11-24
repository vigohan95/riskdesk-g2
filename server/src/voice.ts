// Hold-to-talk voice commands: PCM from the glasses mic -> local STT -> parseCommand -> a plan.
//
// A plan is never an order. It is one of:
//   preview  -> the same priced confirm page a context-menu tap opens (tap to confirm, 5 s to undo)
//   alert    -> a paper price alert (moves no money, so it is set straight away and shown on the result page)
//   refuse   -> a sentence for the glasses saying what was heard and why nothing happened
//
// Safety rules, all here so they can be tested without audio:
// - Voice only reduces risk or watches prices: halve, close, stop-loss, take-profit, cancel all, alerts.
//   "Buy" / "sell" (opening or adding) are refused.
// - A bracket ("stop 54k take 59k") is one confirm page with both legs, and only with exactly two prices,
//   each passing every single-leg check below: if either leg fails, nothing is proposed (never one leg).
//   A third number in the sentence means Whisper split or garbled a price (止损2000期 / 止盈3000一): ask again.
// - No coin heard -> ask again. The parser never guesses BTC vs ETH (Whisper hears ETH as "F" / "earth").
// - A spoken price must be within 1/3x..3x of the live price, otherwise it was misheard by an order of
//   magnitude (六万 vs 六十万) and is refused. A price more than 20% away is allowed but flagged on the page.
// - A stop must be on the losing side of the live exit price, a take-profit on the winning side.

import { parseCommand, type Command, type Lang, type Sym } from './command.ts'

export const SAMPLE_RATE = 16000
export const BYTES_PER_S = SAMPLE_RATE * 2
export const MAX_AUDIO_S = 15
export const MIN_AUDIO_S = 0.4
export const MAG_LOW = 1 / 3
export const MAG_HIGH = 3
export const WARN_FAR = 0.2

export type VoicePlan =
  | { type: 'preview'; kind: 'halve' | 'close' | 'stop' | 'take' | 'cancelAll'; product: string; trigger: number | null; far: boolean }
  | { type: 'preview'; kind: 'bracket'; product: string; trigger: number; take: number; far: boolean }
  | { type: 'alert'; product: string; dir: 'below' | 'above'; price: number; far: boolean }
  | { type: 'refuse'; en: string; zh: string }

export type Market = {
  /** Live mid / last price, or null if the feed is not live. */
  price: (product: string) => number | null
  /** Exit price for the held side: bid if long, ask if short. */
  exit: (product: string) => number | null
  held: (product: string) => number
}

const fmt = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: x < 100 ? 2 : 0 })
const refuse = (en: string, zh: string): VoicePlan => ({ type: 'refuse', en, zh })

export function planVoice(cmd: Command, m: Market): VoicePlan {
  const { intent, sym } = cmd
  if (intent === 'unknown') return refuse('Did not catch a command. Hold and say it again.', '没听懂指令，请按住再说一遍。')
  if (intent === 'buy' || intent === 'sell') return refuse('Voice does not open or add to positions. Use halve / close, or the exchange.', '语音不做开仓或加仓，只能减半 / 平仓 / 止损 / 止盈 / 提醒。')
  if (intent === 'cancelAll') return { type: 'preview', kind: 'cancelAll', product: '*', trigger: null, far: false }
  if (!sym) return refuse('Which coin? Say BTC or ETH with the command.', '没听清是哪个币，请连币种一起再说一遍。')
  const product = `${sym}-USD`
  const live = m.price(product)
  if (live === null) return refuse(`No live ${sym} price right now. Nothing done.`, `现在没有 ${sym} 实时价格，没有执行。`)

  if (intent === 'alertBelow' || intent === 'alertAbove') {
    const p = cmd.nums[0]
    if (p === undefined) return refuse(`Heard an alert for ${sym} but no price. Say it again with the price.`, `听到 ${sym} 提醒，但没听到价格，请带上价格再说。`)
    const bad = magnitude(p, live, sym)
    if (bad) return bad
    const dir = intent === 'alertBelow' ? 'below' : 'above'
    if (dir === 'below' ? live <= p : live >= p) {
      return refuse(`${sym} is already ${dir} ${fmt(p)} (now ${fmt(live)}). No alert set.`, `${sym} 现价 ${fmt(live)}，已经${dir === 'below' ? '低于' : '高于'} ${fmt(p)}，没设提醒。`)
    }
    return { type: 'alert', product, dir, price: p, far: far(p, live) }
  }

  const held = m.held(product)
  if (!held) return refuse(`No ${sym} position to ${intent === 'halve' ? 'halve' : intent === 'close' ? 'close' : 'protect'}.`, `没有 ${sym} 持仓。`)
  if (intent === 'halve' || intent === 'close') return { type: 'preview', kind: intent, product, trigger: null, far: false }

  if (intent === 'bracket') {
    if (cmd.nums.length !== 2) {
      return refuse(`Heard a ${sym} stop and take-profit but not exactly two prices. Say it again, or one at a time.`,
        `听到 ${sym} 止损加止盈，但没听清两个价格，请再说一遍，或者一次说一个。`)
    }
    const [s, t] = cmd.nums
    const bad = leg('stop', s, sym, live, m.exit(product) ?? live, held > 0) ?? leg('take', t, sym, live, m.exit(product) ?? live, held > 0)
    if (bad?.type === 'refuse') {
      return refuse(bad.en.replace(/ Not set\.$/, '') + ' Neither leg set.', bad.zh.replace(/，?没设。$/, '') + '，两张都没设。')
    }
    return { type: 'preview', kind: 'bracket', product, trigger: s, take: t, far: far(s, live) || far(t, live) }
  }

  // stop / take: a spoken price, or none (then the same default distance as the menu).
  const p = cmd.nums[0]
  if (p === undefined) return { type: 'preview', kind: intent, product, trigger: null, far: false }
  const bad = leg(intent, p, sym, live, m.exit(product) ?? live, held > 0)
  if (bad) return bad
  return { type: 'preview', kind: intent, product, trigger: p, far: far(p, live) }
}

/** One stop / take-profit price: refusal, or null when it is plausible and on the right side. */
function leg(kind: 'stop' | 'take', p: number, sym: Sym, live: number, exit: number, long: boolean): VoicePlan | null {
  const bad = magnitude(p, live, sym)
  if (bad) return bad
  // stop below the exit for a long, above it for a short; take-profit the other way
  const mustBeBelow = (kind === 'stop') === long
  if (mustBeBelow ? p >= exit : p <= exit) {
    const name = kind === 'stop' ? ['Stop-loss', '止损'] : ['Take-profit', '止盈']
    return refuse(
      `${name[0]} ${fmt(p)} is ${mustBeBelow ? 'above' : 'below'} the ${sym} ${long ? 'bid' : 'ask'} ${fmt(exit)}: it would fire at once. Not set.`,
      `${name[1]} ${fmt(p)} ${mustBeBelow ? '高于' : '低于'}现在的${long ? '买一价' : '卖一价'} ${fmt(exit)}，会立刻触发，没设。`,
    )
  }
  return null
}

function magnitude(p: number, live: number, sym: Sym): VoicePlan | null {
  if (p >= live * MAG_LOW && p <= live * MAG_HIGH) return null
  return refuse(`Heard ${fmt(p)}, but ${sym} is ${fmt(live)}. Probably misheard; say it again.`, `听到 ${fmt(p)}，但 ${sym} 现价 ${fmt(live)}，可能听错了，请再说一遍。`)
}
const far = (p: number, live: number) => Math.abs(p - live) / live > WARN_FAR

/** One hold-to-talk recording. Chunks arrive in order (100 ms / 3200 bytes each from the glasses). */
export class Recording {
  readonly id: string
  readonly lang: Lang
  readonly startedAt: number
  private parts: Uint8Array[] = []
  private size = 0
  constructor(id: string, lang: Lang, now: number) { this.id = id; this.lang = lang; this.startedAt = now }
  /** Returns false once the recording is full (MAX_AUDIO_S); extra audio is dropped. */
  push(b: Uint8Array): boolean {
    const room = MAX_AUDIO_S * BYTES_PER_S - this.size
    if (room <= 0) return false
    const part = b.length > room ? b.subarray(0, room) : b
    this.parts.push(part)
    this.size += part.length
    return true
  }
  get seconds(): number { return this.size / BYTES_PER_S }
  pcm(): Buffer { return Buffer.concat(this.parts) }
}

/** Splits a 16 kHz mono 16-bit WAV into 3200-byte chunks, the way the glasses mic delivers audio.
 *  Used only by the dev injection endpoint (the simulator has no microphone). */
export function wavChunks(wav: Uint8Array, chunk = 3200): Uint8Array[] {
  const b = Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength)
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file')
  let off = 12
  let fmtOk = false
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4)
    const len = b.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ') {
      const ch = b.readUInt16LE(body + 2), rate = b.readUInt32LE(body + 4), bits = b.readUInt16LE(body + 14)
      if (ch !== 1 || rate !== SAMPLE_RATE || bits !== 16) throw new Error(`need 16 kHz mono 16-bit WAV, got ${rate} Hz ${ch} ch ${bits} bit`)
      fmtOk = true
    } else if (id === 'data') {
      if (!fmtOk) throw new Error('WAV data before fmt chunk')
      const data = b.subarray(body, Math.min(b.length, body + len))
      const out: Uint8Array[] = []
      for (let i = 0; i < data.length; i += chunk) out.push(data.subarray(i, i + chunk))
      return out
    }
    off = body + len + (len % 2)
  }
  throw new Error('WAV has no data chunk')
}

export type SttResult = { text: string; model: string; audio_s: number; stt_ms: number }
export type Transcribe = (pcm: Uint8Array, lang: Lang) => Promise<SttResult>

export function sttClient(base = 'http://127.0.0.1:8788', fetchFn: typeof fetch = fetch): Transcribe {
  return async (pcm, lang) => {
    let res: Response
    try {
      res = await fetchFn(`${base}/transcribe?lang=${lang}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pcm })
    } catch {
      throw new Error('speech service is not running')
    }
    const body: any = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error ?? `speech service HTTP ${res.status}`)
    return body as SttResult
  }
}

/** Transcript -> plan, with the parse kept for logging. */
export function understand(text: string, lang: Lang, m: Market): { cmd: Command; plan: VoicePlan } {
  const cmd = parseCommand(text, lang)
  return { cmd, plan: planVoice(cmd, m) }
}
