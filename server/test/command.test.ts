import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseCommand, zhInt, zhNumbers, enNumbers, WRITE_INTENTS, PRICE_INTENTS, type Command, type Lang } from '../src/command.ts'

type Item = { id: string; lang: Lang; set: string; ref: string; expect: Command; stt: { model: string; prompt: boolean; text: string }[] }
const fx: { items: Item[] } = JSON.parse(readFileSync(new URL('./fixtures/voice-108.json', import.meta.url), 'utf8'))
const same = (a: Command, b: Command) => a.intent === b.intent && a.sym === b.sym && a.nums.length === b.nums.length && a.nums.every((x, i) => Math.abs(x - b.nums[i]) < 1e-9)

// Live prices on 2026-11-21 when the clips were made; used only for the "wrong order of magnitude" bucket.
const PX = { BTC: 55935, ETH: 1562 }
/** What the user would experience: right / pick the coin / asked to repeat / visible mistake on the confirm page / dangerous. */
function grade(g: Command, e: Command): string {
  if (e.intent === 'unknown') return g.intent === 'unknown' || !WRITE_INTENTS.has(g.intent) ? 'right' : 'dangerous'
  const numsOk = same({ ...g, intent: e.intent, sym: e.sym }, e)
  if (g.intent === e.intent && g.sym === e.sym && numsOk) return 'right'
  if (g.intent === e.intent && g.sym === null && numsOk) return 'pickCoin'
  if (g.intent === 'unknown') return 'repeat'
  if (g.intent !== e.intent && WRITE_INTENTS.has(g.intent)) return 'dangerous'
  const s = g.sym ?? e.sym
  if (PRICE_INTENTS.has(g.intent) && s && g.nums.some((x) => !(x / PX[s] >= 1 / 3 && x / PX[s] <= 3))) return 'repeat'
  return 'visible'
}

test('Chinese number forms Whisper produces', () => {
  assert.equal(zhInt('六万五'), 65000)
  assert.equal(zhInt('五万九千五'), 59500)
  assert.equal(zhInt('两千八百五'), 2850)
  assert.equal(zhInt('六万零五百'), 60500)
  assert.equal(zhInt('一千六百零五'), 1605)
  assert.deepEqual(zhNumbers('比特币止损5,9500'), [59500])
  assert.deepEqual(zhNumbers('止损挂在6万1千2'), [61200])
  assert.deepEqual(zhNumbers('BTC跌破6萬提醒我。'), [60000])
  assert.deepEqual(zhNumbers('跌破5万5的时候提醒一下'), [55000])
  assert.deepEqual(zhNumbers('卖出零点零零五个'), [0.005])
  assert.deepEqual(zhNumbers('止盈一千六百八十点五'), [1680.5])
})

test('English number forms Whisper produces', () => {
  assert.deepEqual(enNumbers('fifty nine thousand five hundred'), [59500])
  assert.deepEqual(enNumbers('falls to fourteen fifty'), [1450])
  assert.deepEqual(enNumbers('at sixteen eighty point five'), [1680.5])
  assert.deepEqual(enNumbers('stop loss fifteen hundred, take profit seventeen fifty'), [1500, 1750])
  assert.deepEqual(enNumbers('one thousand nine hundred ninety nine point nine'), [1999.9])
  assert.deepEqual(enNumbers('drops under $55,000'), [55000])
  assert.deepEqual(enNumbers('at 60k'), [60000])
  assert.deepEqual(enNumbers('zero point zero zero five'), [0.005])
  assert.deepEqual(enNumbers('buy half an eth'), [0.5])
})

test('all 108 reference sentences parse exactly (dev, held-out and colloquial sets)', () => {
  const bad = fx.items.filter((it) => !same(parseCommand(it.ref, it.lang), it.expect)).map((it) => `${it.id} ${it.ref} -> ${JSON.stringify(parseCommand(it.ref, it.lang))}`)
  assert.equal(fx.items.length, 108)
  assert.deepEqual(bad, [])
})

test('real Whisper transcripts: never a dangerous error, in every model / prompt setting', () => {
  const tally: Record<string, Record<string, number>> = {}
  const danger: string[] = []
  for (const it of fx.items) for (const s of it.stt) {
    const g = grade(parseCommand(s.text, it.lang), it.expect)
    const k = `${s.model}${s.prompt ? '+prompt' : ''} ${it.lang}`
    ;(tally[k] ??= {})[g] = (tally[k][g] ?? 0) + 1
    if (g === 'dangerous') danger.push(`${k} ${it.id} 「${s.text}」 -> ${JSON.stringify(parseCommand(s.text, it.lang))}`)
  }
  if (process.env.VOICE_REPORT) console.log(JSON.stringify(tally, null, 1))
  assert.deepEqual(danger, [])
})

test('shipping setting (zh: small + prompt, en: base + prompt) gets most commands right first time', () => {
  for (const [lang, model, min] of [['zh', 'small', 0.85], ['en', 'base', 0.8]] as const) {
    const rows = fx.items.filter((it) => it.lang === lang).flatMap((it) => it.stt.filter((s) => s.model === model && s.prompt).map((s) => grade(parseCommand(s.text, lang), it.expect)))
    const right = rows.filter((g) => g === 'right' || g === 'pickCoin').length / rows.length
    assert.ok(rows.length >= 54, `${lang}: ${rows.length}`)
    assert.ok(right >= min, `${lang} ${model}: ${(right * 100).toFixed(1)}%`)
  }
})

test('a stop or take with two prices (other bracket leg misheard) asks again instead of placing one leg', () => {
  assert.equal(parseCommand('比特币指损6万1,指赢6万4。', 'zh').intent, 'bracket')
  assert.equal(parseCommand('以太坊止损2000期,只迎3000一。', 'zh').intent, 'bracket')
  assert.equal(parseCommand('比特币止损6万1,止什么6万4', 'zh').intent, 'unknown')
  assert.deepEqual(parseCommand('Set a stop on ETH at one thousand four hundred eighty', 'en'), { intent: 'stop', sym: 'ETH', nums: [1480] })
})
