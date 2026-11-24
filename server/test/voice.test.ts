import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { planVoice, understand, Recording, wavChunks, sttClient, MAX_AUDIO_S, BYTES_PER_S, type Market, type VoicePlan } from '../src/voice.ts'
import { PriceAlerts } from '../src/alerts.ts'
import { ActionDesk } from '../src/actions.ts'
import { PaperLedger } from '../src/ledger.ts'
import type { Command, Lang } from '../src/command.ts'

// Prices on 2026-11-21 when the 108 test clips were recorded (same as command.test.ts).
const PX: Record<string, number> = { 'BTC-USD': 55935, 'ETH-USD': 1562 }
const mkt = (held: Record<string, number> = { 'BTC-USD': 0.02, 'ETH-USD': 1.5 }): Market => ({
  price: (p) => PX[p] ?? null,
  exit: (p) => (PX[p] ? ((held[p] ?? 0) < 0 ? PX[p] + 1 : PX[p] - 1) : null),
  held: (p) => held[p] ?? 0,
})
const cmd = (intent: Command['intent'], sym: Command['sym'], nums: number[] = []): Command => ({ intent, sym, nums })
const kind = (p: VoicePlan) => (p.type === 'preview' ? `preview:${p.kind}` : p.type)

test('risk-reducing intents become previews, never orders', () => {
  assert.deepEqual(planVoice(cmd('halve', 'BTC'), mkt()), { type: 'preview', kind: 'halve', product: 'BTC-USD', trigger: null, far: false })
  assert.equal(kind(planVoice(cmd('close', 'ETH'), mkt())), 'preview:close')
  assert.equal(kind(planVoice(cmd('cancelAll', null), mkt())), 'preview:cancelAll')
  assert.equal(kind(planVoice(cmd('stop', 'BTC'), mkt())), 'preview:stop') // no price: menu default distance
})

test('opening / adding is refused', () => {
  for (const c of [cmd('buy', 'BTC', [0.01]), cmd('sell', 'ETH', [1]), cmd('unknown', 'BTC', [3])]) {
    assert.equal(planVoice(c, mkt()).type, 'refuse', c.intent)
  }
})

test('bracket: both legs on one confirm page, or nothing', () => {
  assert.deepEqual(planVoice(cmd('bracket', 'BTC', [54000, 59000]), mkt()), { type: 'preview', kind: 'bracket', product: 'BTC-USD', trigger: 54000, take: 59000, far: false })
  // either leg failing refuses the whole bracket: wrong side, order of magnitude
  assert.equal(planVoice(cmd('bracket', 'BTC', [61000, 64000]), mkt()).type, 'refuse') // stop above the bid
  assert.match((planVoice(cmd('bracket', 'BTC', [54000, 55000]), mkt()) as any).zh, /^止盈 55,000 低于.*会立刻触发，两张都没设。$/)
  assert.match((planVoice(cmd('bracket', 'ETH', [1500, 17005]), mkt()) as any).en, /^Heard 17,005, but ETH is 1,562. Probably misheard; say it again. Neither leg set.$/)
  assert.equal(planVoice(cmd('bracket', 'BTC', [54000, 55000]), mkt()).type, 'refuse') // take below the bid
  assert.equal(planVoice(cmd('bracket', 'ETH', [1500, 17005]), mkt()).type, 'refuse') // 一千七百五 heard as 17005
  // anything but exactly two prices: ask again (止损2000期 / 止盈3000一 -> a stray third number)
  for (const n of [[], [54000], [54000, 59000, 1]]) assert.equal(planVoice(cmd('bracket', 'BTC', n), mkt()).type, 'refuse', String(n))
  // a short position mirrors the sides
  assert.equal(kind(planVoice(cmd('bracket', 'BTC', [58000, 53000]), mkt({ 'BTC-USD': -0.02 }))), 'preview:bracket')
  const far = planVoice(cmd('bracket', 'BTC', [54000, 70000]), mkt())
  assert.equal(far.type === 'preview' && far.far, true)
  assert.equal(planVoice(cmd('bracket', 'BTC', [54000, 59000]), mkt({})).type, 'refuse') // no position
})

test('no coin heard: ask again, never guess', () => {
  const p = planVoice(cmd('halve', null), mkt())
  assert.equal(p.type, 'refuse')
  assert.match((p as any).zh, /哪个币/)
})

test('spoken price off by an order of magnitude is refused; >20% is flagged', () => {
  assert.equal(planVoice(cmd('stop', 'BTC', [5300]), mkt()).type, 'refuse') // 五千三 instead of 五万三
  assert.equal(planVoice(cmd('alertBelow', 'BTC', [500000]), mkt()).type, 'refuse')
  assert.deepEqual(planVoice(cmd('stop', 'BTC', [53000]), mkt()), { type: 'preview', kind: 'stop', product: 'BTC-USD', trigger: 53000, far: false })
  const far = planVoice(cmd('stop', 'BTC', [40000]), mkt())
  assert.equal(far.type === 'preview' && far.far, true)
})

test('stop / take on the wrong side of the price is refused (would fire at once)', () => {
  assert.equal(planVoice(cmd('stop', 'BTC', [57000]), mkt()).type, 'refuse') // long: stop must be below the bid
  assert.equal(planVoice(cmd('take', 'BTC', [54000]), mkt()).type, 'refuse')
  assert.equal(kind(planVoice(cmd('take', 'BTC', [60000]), mkt())), 'preview:take')
  // short position: the other way round
  const short = mkt({ 'BTC-USD': -0.02 })
  assert.equal(kind(planVoice(cmd('stop', 'BTC', [58000]), short)), 'preview:stop')
  assert.equal(planVoice(cmd('stop', 'BTC', [54000]), short).type, 'refuse')
})

test('no position: halve / close / stop refused; alerts still work', () => {
  const flat = mkt({})
  assert.equal(planVoice(cmd('halve', 'ETH'), flat).type, 'refuse')
  assert.equal(planVoice(cmd('stop', 'ETH', [1500]), flat).type, 'refuse')
  assert.deepEqual(planVoice(cmd('alertBelow', 'ETH', [1500]), flat), { type: 'alert', product: 'ETH-USD', dir: 'below', price: 1500, far: false })
})

test('alert already crossed or without a price is refused', () => {
  assert.equal(planVoice(cmd('alertBelow', 'BTC', [58000]), mkt()).type, 'refuse') // already below 58k
  assert.equal(planVoice(cmd('alertAbove', 'BTC', []), mkt()).type, 'refuse')
  assert.equal(kind(planVoice(cmd('alertAbove', 'BTC', [58000]), mkt())), 'alert')
})

test('no live price: nothing is planned', () => {
  const dead: Market = { price: () => null, exit: () => null, held: () => 1 }
  assert.equal(planVoice(cmd('halve', 'BTC'), dead).type, 'refuse')
})

// End to end on the 312 real Whisper transcripts of the 108 recorded commands: whatever the parser makes of a
// misheard sentence, the plan that reaches the glasses must never be a *different* write or alert than the one spoken.
test('312 real transcripts: no plan acts on the wrong coin, side, kind or price', () => {
  type Item = { id: string; lang: Lang; expect: Command; stt: { model: string; prompt: boolean; text: string }[] }
  const fx: { items: Item[] } = JSON.parse(readFileSync(new URL('./fixtures/voice-108.json', import.meta.url), 'utf8'))
  const m = mkt()
  let n = 0, acted = 0, refused = 0
  const wrong: string[] = []
  const wrongAlertPrice: string[] = []
  for (const it of fx.items) {
    for (const s of it.stt) {
      n++
      const { plan } = understand(s.text, it.lang, m)
      if (plan.type === 'refuse') { refused++; continue }
      acted++
      const e = it.expect
      const eKind = e.intent === 'alertBelow' || e.intent === 'alertAbove' ? 'alert' : `preview:${e.intent}`
      const eProduct = e.intent === 'cancelAll' ? '*' : `${e.sym}-USD`
      const gotPrice = plan.type === 'alert' ? plan.price : plan.kind === 'bracket' ? `${plan.trigger}/${plan.take}` : plan.trigger
      const ePrice = e.intent === 'bracket' ? `${e.nums[0]}/${e.nums[1]}` : ['stop', 'take', 'alertBelow', 'alertAbove'].includes(e.intent) ? e.nums[0] ?? null : null
      const dirOk = plan.type !== 'alert' || plan.dir === (e.intent === 'alertBelow' ? 'below' : 'above')
      if (kind(plan) !== eKind || plan.product !== eProduct || gotPrice !== ePrice || !dirOk) {
        ;(plan.type === 'alert' && eKind === 'alert' && plan.product === eProduct && dirOk ? wrongAlertPrice : wrong)
          .push(`${it.id} ${s.model}${s.prompt ? '+p' : ''} "${s.text}" -> ${JSON.stringify(plan)}`)
      }
    }
  }
  assert.equal(n, 312)
  assert.deepEqual(wrong, [])
  // Whisper misheard the number itself (五万八 -> 51800, 一千六百零五 -> 1650, "1525.5" -> "1500-25.5"); the parser cannot
  // know. An alert moves no money, is shown with what was heard, and one tap removes it. Pinned so it cannot grow.
  assert.equal(wrongAlertPrice.length, 3, wrongAlertPrice.join(' | '))
  assert.ok(acted > 100 && refused > 100, `acted ${acted}, refused ${refused}`) // buy / sell are refused by design
})

// How often the user gets the same plan from a transcript as from the sentence they actually said
// (only commands whose reference sentence is actionable at the 11-21 prices: 36 per configuration, brackets included).
test('shipping STT configs: same plan as the spoken sentence on 34/36 (zh small+prompt) and 33/36 (en base+prompt)', () => {
  type Item = { lang: Lang; ref: string; stt: { model: string; prompt: boolean; text: string }[] }
  const fx: { items: Item[] } = JSON.parse(readFileSync(new URL('./fixtures/voice-108.json', import.meta.url), 'utf8'))
  const m = mkt()
  const score: Record<string, [number, number]> = {}
  for (const it of fx.items) {
    const ref = JSON.stringify(understand(it.ref, it.lang, m).plan)
    if (ref.includes('"refuse"')) continue
    for (const s of it.stt) {
      const k = `${it.lang} ${s.model}${s.prompt ? '+p' : ''}`
      score[k] ??= [0, 0]
      score[k][1]++
      if (JSON.stringify(understand(s.text, it.lang, m).plan) === ref) score[k][0]++
    }
  }
  assert.deepEqual(score['zh small+p'], [34, 36])
  assert.deepEqual(score['en base+p'], [33, 36])
})

test('recording caps at MAX_AUDIO_S and concatenates in order', () => {
  const r = new Recording('r', 'zh', 0)
  r.push(new Uint8Array([1, 2]))
  r.push(new Uint8Array([3]))
  assert.deepEqual([...r.pcm()], [1, 2, 3])
  const big = new Uint8Array(MAX_AUDIO_S * BYTES_PER_S)
  r.push(big)
  assert.equal(r.pcm().length, MAX_AUDIO_S * BYTES_PER_S)
  assert.equal(r.push(new Uint8Array(10)), false)
})

function wav(samples: number, rate = 16000, ch = 1): Uint8Array {
  const data = samples * 2 * ch
  const b = Buffer.alloc(44 + data)
  b.write('RIFF', 0); b.writeUInt32LE(36 + data, 4); b.write('WAVE', 8)
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(ch, 22)
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2 * ch, 28); b.writeUInt16LE(2 * ch, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36); b.writeUInt32LE(data, 40)
  return b
}

test('WAV is cut into 3200-byte chunks like the G2 mic; wrong formats are rejected', () => {
  const c = wavChunks(wav(16000 + 800)) // 1.05 s
  assert.equal(c.length, 11)
  assert.equal(c[0].length, 3200)
  assert.equal(c[10].length, 1600)
  assert.throws(() => wavChunks(wav(100, 44100)), /16 kHz/)
  assert.throws(() => wavChunks(wav(100, 16000, 2)), /mono/)
  assert.throws(() => wavChunks(new Uint8Array(40)), /not a WAV/)
})

test('stt client: posts raw PCM with the language, surfaces service errors', async () => {
  let seen = ''
  const ok = sttClient('http://x', (async (url: string, init: any) => { seen = `${url} ${init.body.length}`; return new Response(JSON.stringify({ text: 'hi', model: 'base', audio_s: 1, stt_ms: 5 })) }) as any)
  assert.equal((await ok(new Uint8Array(32000), 'en')).text, 'hi')
  assert.equal(seen, 'http://x/transcribe?lang=en 32000')
  const down = sttClient('http://x', (async () => { throw new Error('ECONNREFUSED') }) as any)
  await assert.rejects(down(new Uint8Array(1), 'zh'), /not running/)
  const bad = sttClient('http://x', (async () => new Response(JSON.stringify({ error: 'audio too short' }), { status: 400 })) as any)
  await assert.rejects(bad(new Uint8Array(1), 'zh'), /too short/)
})

test('price alerts: one per product and direction, removed when crossed', () => {
  const a = new PriceAlerts()
  assert.equal(a.set({ id: '1', product: 'BTC-USD', dir: 'below', price: 55000, createdAt: 0 }), null)
  assert.equal(a.set({ id: '2', product: 'BTC-USD', dir: 'below', price: 54000, createdAt: 1 })?.price, 55000)
  a.set({ id: '3', product: 'BTC-USD', dir: 'above', price: 58000, createdAt: 2 })
  assert.equal(a.size, 2)
  assert.deepEqual(a.check('BTC-USD', 55000), [])
  assert.deepEqual(a.check('BTC-USD', 53999.5).map((x) => x.id), ['2'])
  assert.equal(a.size, 1)
  assert.deepEqual(a.check('ETH-USD', 99999), [])
  assert.deepEqual(a.check('BTC-USD', 58000).map((x) => x.id), ['3'])
})

test('desk preview takes a spoken trigger, keeps the transcript, refuses the wrong side', () => {
  const ledger = new PaperLedger()
  ledger.apply({ id: 's', product: 'BTC-USD', side: 'BUY', qty: 0.02, price: 50000, t: 0 })
  const desk = new ActionDesk({ ledger, quote: () => ({ bid: 55935, ask: 55936 }), placeOrder: async () => ({ ok: true, orderId: 'x' }), newId: () => 'v1' })
  const p = desk.preview('stop', 'BTC-USD', { trigger: 53000.004, heard: '比特币止损五万三', far: false })
  assert.equal(p.trigger, 53000)
  assert.equal(p.heard, '比特币止损五万三')
  assert.ok(Math.abs(p.estNet - (0.02 * 53000 - 0.02 * 53000 * ledger.feeRate)) < 1e-9)
  assert.throws(() => desk.preview('stop', 'BTC-USD', { trigger: 56000 }), /fire at once/)
  assert.equal(desk.preview('halve', 'BTC-USD').heard, null)
})
