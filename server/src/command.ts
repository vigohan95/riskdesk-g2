// Spoken command -> intent. Rule based on purpose: every write still goes through the confirm page,
// so the parser must never turn one write action into a different one; when unsure it says "unknown".
//
// Input is a faster-whisper transcript (Chinese or English). What Whisper actually produces, measured on
// 108 TTS commands before the hackathon (test/fixtures/voice-108.json):
// - Chinese numbers come back mixed: 六万五 / 6万5 / 5,9500 / 6万1千2 / 6萬 (traditional), sometimes 55,050
// - coin names get misheard: 以太房, 币特币, earth, ether
// - English prices come as words ("fourteen fifty", "sixteen eighty point five") or digits ("$55,000", "60k")
// - "Sell" can come back as "cell"; "Halve my" as "have my"; "Buy" as "By"

export type Intent = 'alertBelow' | 'alertAbove' | 'halve' | 'close' | 'stop' | 'take' | 'bracket' | 'sell' | 'buy' | 'cancelAll' | 'unknown'
export type Sym = 'BTC' | 'ETH'
export type Command = { intent: Intent; sym: Sym | null; nums: number[] }
export type Lang = 'en' | 'zh'

/** Intents that change orders or positions (a wrong one here is the dangerous kind of error). */
export const WRITE_INTENTS: ReadonlySet<Intent> = new Set(['halve', 'close', 'stop', 'take', 'bracket', 'sell', 'buy', 'cancelAll'])
/** Intents whose numbers are prices (checked against the live price before the confirm page). */
export const PRICE_INTENTS: ReadonlySet<Intent> = new Set(['stop', 'take', 'bracket', 'alertBelow', 'alertAbove'])

// Whisper's small model sometimes answers in traditional characters even with language=zh.
const T2S: Record<string, string> = {
  萬: '万', 點: '点', 兩: '两', 幣: '币', 單: '单', 掛: '挂', 損: '损', 漲: '涨', 減: '减', 銷: '销', 賣: '卖', 買: '买',
  倉: '仓', 價: '价', 設: '设', 個: '个', 時: '时', 說: '说', 幫: '帮', 請: '请', 現: '现', 過: '过', 這: '这', 還: '还',
  麼: '么', 讓: '让', 訂: '订', 觸: '触', 線: '线', 盤: '盘', 錢: '钱', 後: '后', 給: '给', 聲: '声', 號: '号', 開: '开',
}
const toSimplified = (s: string) => s.replace(/[^\x00-\x7f]/g, (c) => T2S[c] ?? c)

const SYMS: [Sym, RegExp][] = [
  ['BTC', /btc|比特币|币特币|bitcoin|比特/],
  ['ETH', /\beth\b|以太坊|以太|ethereum|\bether\b|\bearth\b/],
]

// ---------- Chinese numbers ----------
const ZD: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 幺: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const ZU: Record<string, number> = { 十: 10, 百: 100, 千: 1000 }

/** 六万五 = 65000, 五万九千五 = 59500, 两千八百五 = 2850, 六万零五百 = 60500, 一千六百零五 = 1605 */
export function zhInt(s: string): number | null {
  let total = 0, sec = 0, num = 0, lastUnit = 1
  for (const ch of s) {
    if (ch in ZD) num = ZD[ch]
    else if (ch in ZU) { sec += (num || 1) * ZU[ch]; lastUnit = ZU[ch]; num = 0 }
    else if (ch === '万') { sec += num; total += sec * 10000; sec = 0; num = 0; lastUnit = 10000 }
    else return null
  }
  // A trailing digit right after a unit drops the next unit down: 六万五 -> 5 x 1000. After 零 it is a plain digit.
  const chars = [...s]
  const prev = chars.length >= 2 ? chars[chars.length - 2] : ''
  if (num && lastUnit >= 10 && (prev in ZU || prev === '万')) num *= lastUnit / 10
  return total + sec + num
}
export function zhNum(s: string): number | null {
  const i = s.indexOf('点')
  if (i < 0) return zhInt(s)
  const a = s.slice(0, i), b = s.slice(i + 1)
  const ia = a ? zhInt(a) : 0
  if (ia === null || !b || [...b].some((c) => !(c in ZD))) return null
  return Number(`${ia}.${[...b].map((c) => ZD[c]).join('')}`)
}

/** All numbers in a Chinese transcript, in order. */
export function zhNumbers(text: string): number[] {
  let t = toSimplified(text).replace(/，/g, ',').replace(/[。\s]/g, '')
  t = t.replace(/一下|一声|一半|统一|一起|一直/g, '')
  t = t.replace(/(\d),(\d{4})(?!\d)/g, '$1$2') // 5,9500 -> 59500 (Whisper groups by 万, not thousands)
  t = t.replace(/(\d),(\d{3})(?!\d)/g, '$1$2') // 55,050 -> 55050
  t = t.replace(/(\d+)万(\d)千(\d)(?![\d万千百])/g, (_, a, b, c) => String(+a * 10000 + +b * 1000 + +c * 100)) // 6万1千2
  t = t.replace(/(\d+)万(\d*)(千)?/g, (_, a: string, b: string, k: string | undefined) => {
    if (!b) return String(+a * 10000) // 6万
    if (k || b.length === 1) return String(+a * 10000 + +b * 1000) // 6万5 / 6万5千
    return String(+a * 10000 + +b) // 6万0500
  })
  const out: number[] = []
  for (const m of t.matchAll(/\d+(?:\.\d+)?|[零〇一幺二两三四五六七八九十百千万点]+/g)) {
    const g = m[0]
    const v = /\d/.test(g) ? Number(g) : zhNum(g)
    if (v !== null && (v !== 0 || g.includes('点') || g === '0')) out.push(v)
  }
  return out
}

// ---------- English numbers ----------
const EN: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
}

/** Numbers in an English transcript: words ("fifty nine thousand five hundred", "fourteen fifty", "zero point zero one",
 *  "half an") and digits ("$55,000", "1,680.5", "60k"). */
export function enNumbers(text: string): number[] {
  const toks = text.toLowerCase().replace(/(\d),(?=\d{3}\b)/g, '$1').match(/[a-z]+|\d+(?:\.\d+)?k?/g) ?? []
  const out: number[] = []
  let i = 0
  while (i < toks.length) {
    const t = toks[i]
    if (t === 'half' && (toks[i + 1] === 'a' || toks[i + 1] === 'an')) { out.push(0.5); i += 2; continue }
    if (/^\d/.test(t)) { out.push(t.endsWith('k') ? Number(t.slice(0, -1)) * 1000 : Number(t)); i++; continue }
    if (!(t in EN) && t !== 'hundred' && t !== 'thousand') { i++; continue }
    let total = 0, cur = 0, dec: string | null = null
    while (i < toks.length) {
      const w = toks[i]
      if (w === 'and' && cur + total > 0) { i++; continue }
      if (w === 'point' && dec === null && i + 1 < toks.length && toks[i + 1] in EN && EN[toks[i + 1]] < 10) { dec = ''; i++; continue }
      if (dec !== null) { if (w in EN && EN[w] < 10) { dec += EN[w]; i++; continue } break }
      if (w === 'hundred') cur = (cur || 1) * 100
      else if (w === 'thousand') { total += (cur || 1) * 1000; cur = 0 }
      else if (w in EN) {
        const v = EN[w]
        // "fourteen fifty" / "sixteen eighty": a two-digit number followed by another one reads like a year
        if (cur >= 10 && cur < 100 && v >= 10) cur = cur * 100 + v
        else cur += v
      } else break
      i++
    }
    const v = total + cur
    out.push(dec ? Number(`${v}.${dec}`) : v)
  }
  return out
}

// ---------- intent ----------
const STOP = ['止损', '只损', '指损', 'stop']
const TAKE = ['止盈', '指盈', '指贫', '只赢', '只盈', '止赢', '指赢', '只迎', '止迎', 'take profit']
const ALERT = ['提醒', '醒我', '叫我', '跟我说', '告诉我', '通知我', 'alert', 'notify', 'ping me', 'let me know', 'tell me', 'heads up']
const BELOW = ['跌', 'below', 'drop', 'fall', 'under', 'dip']

export function parseCommand(text: string, lang: Lang): Command {
  const low = toSimplified(text.toLowerCase())
  const sym = SYMS.find(([, re]) => re.test(low))?.[0] ?? null
  const nums = lang === 'zh' ? zhNumbers(text) : enNumbers(low)
  const has = (...ws: string[]) => ws.some((w) => low.includes(w))
  const word = (...ws: string[]) => ws.some((w) => new RegExp(`\\b${w}\\b`).test(low))
  const r = (intent: Intent, n: number[] = []): Command => ({ intent, sym: intent === 'cancelAll' ? null : sym, nums: n })

  if (has('撤', 'cancel') || word('kill')) return r('cancelAll')
  if (has('减半', '砍一半', '减一半', '解一半', '卖掉一半', '卖一半', '砍半') || word('halve') ||
      (has('half') && (has('cut', 'position') || word('sell'))) || /\bhave my\b.*\bposition\b/.test(low)) return r('halve')
  if (has('平掉', '平仓', '平调', '平了', 'close') || word('flatten')) return r('close')
  if (has(...STOP) && has(...TAKE, 'profit')) return r('bracket', nums.slice(0, 2))
  // A single stop / take with two prices means half the sentence was misheard (usually the other leg of a
  // bracket): ask again rather than silently placing only one leg.
  if (has(...STOP)) return nums.length >= 2 ? { intent: 'unknown', sym, nums } : r('stop', nums)
  if (has(...TAKE)) return nums.length >= 2 ? { intent: 'unknown', sym, nums } : r('take', nums)
  if (has(...ALERT)) return r(has(...BELOW) ? 'alertBelow' : 'alertAbove', nums.slice(0, 1))
  if (has('卖') || word('sell', 'sells', 'cell', 'cells', 'cel')) return r('sell', nums.slice(0, 1))
  if (has('买', 'buy') || /^\s*by\b/.test(low)) return r('buy', nums.slice(0, 1))
  return { intent: 'unknown', sym, nums }
}
