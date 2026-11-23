// One-tap actions with a 5-second undo window.
//
// preview()  -> a fully priced proposal (what will be sold, at roughly what, fee, net, exposure before/after).
// confirm()  -> armed; nothing is sent yet. A countdown runs for UNDO_MS.
// undo()     -> inside the window: cancelled, nothing was ever sent.
// fire       -> after the window: one Coinbase Advanced Trade order request (sandbox by default) with
//               client_order_id = action id, so a retried or double-tapped confirm can never create two orders.
//               On success the paper ledger books the fill at the bid/ask *at execution time*, not at preview time.
// A preview older than PREVIEW_TTL_MS or whose price moved more than MAX_DRIFT is refused at confirm:
// the user must look at a fresh number before money moves.
//
// The same preview -> confirm -> undo flow also places paper resting orders (stop / take-profit, see
// orders.ts) and cancels them all. Those touch no exchange when confirmed; when a resting order's
// trigger is crossed, onQuote() sends one market IOC order for it, exactly like a manual close.

import { randomUUID } from 'node:crypto'
import type { PaperLedger, Quote, Fill } from './ledger.ts'
import { PaperOrderBook, triggerFor, STOP_PCT, TAKE_PCT } from './orders.ts'

export const UNDO_MS = 5000
export const PREVIEW_TTL_MS = 30_000
export const MAX_DRIFT = 0.01 // 1%

export type ActionKind = 'halve' | 'close' | 'stop' | 'take' | 'cancelAll'
export const ACTION_KINDS: ActionKind[] = ['halve', 'close', 'stop', 'take', 'cancelAll']
export type Proposal = {
  id: string
  kind: ActionKind
  product: string // '*' for cancelAll
  side: 'BUY' | 'SELL'
  qty: number
  estPrice: number // halve / close: bid or ask now; stop / take: the trigger
  estFee: number
  estNet: number // cash in (+) or out (-) after fee
  exposureBefore: number
  exposureAfter: number
  createdAt: number
  /** The exit price seen at preview (bid for a sell, ask for a buy); confirm refuses if it moved > MAX_DRIFT. */
  refPrice: number
  /** stop / take: trigger price (== estPrice). */
  trigger: number | null
  /** stop / take: trigger of the order of the same kind this one replaces. */
  replaces: number | null
  /** cancelAll: how many resting orders will be cancelled. */
  affected: number | null
  /** true when a resting order fired by itself (no tap). */
  auto: boolean
}
export type ActionState =
  | { status: 'proposed'; p: Proposal }
  | { status: 'armed'; p: Proposal; fireAt: number }
  | { status: 'undone'; p: Proposal }
  | { status: 'sending'; p: Proposal }
  | { status: 'filled'; p: Proposal; fill: Fill; orderId: string }
  | { status: 'placed'; p: Proposal; affected: number } // stop / take now rests in the paper book, or cancelAll done
  | { status: 'failed'; p: Proposal; reason: string }

export type OrderRequest = { client_order_id: string; product_id: string; side: 'BUY' | 'SELL'; order_configuration: { market_market_ioc: { base_size: string } } }
export type OrderResult = { ok: true; orderId: string } | { ok: false; reason: string }
export type PlaceOrder = (req: OrderRequest) => Promise<OrderResult>

export const SANDBOX = 'https://api-sandbox.coinbase.com/api/v3/brokerage'

/** Coinbase Advanced Trade "Create Order". The public sandbox needs no key and returns canned bodies;
 *  we only rely on its `success` flag. Production differs only by base URL + a signed JWT header. */
export function coinbaseOrders(base = SANDBOX, fetchFn: typeof fetch = fetch): PlaceOrder {
  return async (req) => {
    try {
      const res = await fetchFn(`${base}/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) })
      const body: any = await res.json().catch(() => ({}))
      if (res.ok && body.success === true) return { ok: true, orderId: String(body.success_response?.order_id ?? '') }
      return { ok: false, reason: body.error_response?.message ?? body.failure_reason ?? `HTTP ${res.status}` }
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
  }
}

/** Base size string: Coinbase rejects excess precision; 8 decimals covers BTC/ETH increments. */
export const baseSize = (q: number) => q.toFixed(8).replace(/0+$/, '').replace(/\.$/, '')
const round12 = (x: number) => (Math.abs(x) < 1e-12 ? 0 : Math.round(x * 1e12) / 1e12)

export type ActionDeps = {
  ledger: PaperLedger
  book?: PaperOrderBook
  stopPct?: number
  takePct?: number
  quote: (product: string) => Quote | null
  placeOrder: PlaceOrder
  onFill?: (f: Fill) => void
  onChange?: (s: ActionState) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
  newId?: () => string
}

export class ActionDesk {
  private states = new Map<string, ActionState>()
  private timers = new Map<string, unknown>()
  private d: Required<ActionDeps>

  constructor(deps: ActionDeps) {
    this.d = {
      onFill: () => {},
      onChange: () => {},
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as any),
      newId: () => randomUUID(),
      book: new PaperOrderBook(),
      stopPct: STOP_PCT,
      takePct: TAKE_PCT,
      ...deps,
    }
  }

  get book(): PaperOrderBook { return this.d.book }
  get(id: string): ActionState | undefined { return this.states.get(id) }
  /** Armed actions still inside their undo window (the glasses show these as a countdown). */
  armed(): Extract<ActionState, { status: 'armed' }>[] {
    return [...this.states.values()].filter((s): s is Extract<ActionState, { status: 'armed' }> => s.status === 'armed')
  }

  preview(kind: ActionKind, product: string): Proposal {
    const { ledger, book } = this.d
    const base = { id: this.d.newId(), createdAt: this.d.now(), replaces: null, affected: null, auto: false }
    if (kind === 'cancelAll') {
      if (!book.size) throw new Error('no open orders')
      return this.propose({
        ...base, kind, product: '*', side: 'SELL', qty: 0, estPrice: 0, estFee: 0, estNet: 0,
        exposureBefore: 0, exposureAfter: 0, refPrice: 0, trigger: null, affected: book.size,
      })
    }
    const q = this.d.quote(product)
    if (!q) throw new Error(`no live quote for ${product}`)
    const held = ledger.qty(product)
    if (!held) throw new Error(`no ${product} position`)
    const side = held > 0 ? 'SELL' : 'BUY'
    const refPrice = side === 'SELL' ? q.bid : q.ask
    if (kind === 'stop' || kind === 'take') {
      // Protects the whole position; the money shown is what the fill would be at the trigger.
      const trigger = triggerFor(kind, held, refPrice, this.d.stopPct, this.d.takePct)
      const qty = Math.abs(held)
      const fee = qty * trigger * ledger.feeRate
      return this.propose({
        ...base, kind, product, side, qty, estPrice: trigger, estFee: fee,
        estNet: side === 'SELL' ? qty * trigger - fee : -(qty * trigger + fee),
        exposureBefore: held, exposureAfter: 0, refPrice, trigger,
        replaces: book.find(product, kind)?.trigger ?? null,
      })
    }
    const qtyAbs = kind === 'close' ? Math.abs(held) : Math.abs(held) / 2
    const notional = qtyAbs * refPrice
    const estFee = notional * ledger.feeRate
    return this.propose({
      ...base, kind, product, side, qty: qtyAbs, estPrice: refPrice, estFee,
      estNet: side === 'SELL' ? notional - estFee : -(notional + estFee),
      exposureBefore: held, exposureAfter: round12(held - Math.sign(held) * qtyAbs), refPrice, trigger: null,
    })
  }

  /** Returns the state after the call. Confirming twice is a no-op (double-tap safe). */
  confirm(id: string): ActionState {
    const s = this.states.get(id)
    if (!s) throw new Error(`unknown action ${id}`)
    if (s.status !== 'proposed') return s
    const age = this.d.now() - s.p.createdAt
    if (age > PREVIEW_TTL_MS) return this.set({ status: 'failed', p: s.p, reason: 'preview expired, look again' })
    if (s.p.kind !== 'cancelAll') {
      const q = this.d.quote(s.p.product)
      const px = q ? (s.p.side === 'SELL' ? q.bid : q.ask) : NaN
      if (!(px > 0)) return this.set({ status: 'failed', p: s.p, reason: 'no live quote' })
      if (Math.abs(px - s.p.refPrice) / s.p.refPrice > MAX_DRIFT) return this.set({ status: 'failed', p: s.p, reason: 'price moved >1%, look again' })
    }
    const fireAt = this.d.now() + UNDO_MS
    this.timers.set(id, this.d.setTimer(() => { void this.fire(id) }, UNDO_MS))
    return this.set({ status: 'armed', p: s.p, fireAt })
  }

  undo(id: string): ActionState {
    const s = this.states.get(id)
    if (!s) throw new Error(`unknown action ${id}`)
    if (s.status !== 'armed' && s.status !== 'proposed') return s // too late: already sent
    const t = this.timers.get(id)
    if (t !== undefined) this.d.clearTimer(t)
    this.timers.delete(id)
    return this.set({ status: 'undone', p: s.p })
  }

  /** Call on every quote update of `product`: fires a crossed stop / take-profit (at most one per product). */
  async onQuote(product: string): Promise<void> {
    const q = this.d.quote(product)
    if (!q) return // never trigger on a stale or missing quote
    const o = this.d.book.take(product, q)
    if (!o) return
    const fee = this.d.ledger.feeRate
    await this.execute({
      id: o.id, kind: o.kind, product, side: o.side, qty: o.qty, estPrice: o.trigger, estFee: o.qty * o.trigger * fee,
      estNet: o.side === 'SELL' ? o.qty * o.trigger * (1 - fee) : -o.qty * o.trigger * (1 + fee),
      exposureBefore: this.d.ledger.qty(product), exposureAfter: 0, createdAt: this.d.now(), refPrice: o.trigger,
      trigger: o.trigger, replaces: null, affected: null, auto: true,
    })
  }

  private async fire(id: string) {
    const s = this.states.get(id)
    this.timers.delete(id)
    if (!s || s.status !== 'armed') return
    const { p } = s
    const { book } = this.d
    if (p.kind === 'cancelAll') { this.set({ status: 'placed', p, affected: book.cancelAll() }); return }
    if (p.kind === 'stop' || p.kind === 'take') {
      const held = this.d.ledger.qty(p.product)
      if (!held || (held > 0 ? 'SELL' : 'BUY') !== p.side) { this.set({ status: 'failed', p, reason: 'position changed, look again' }); return }
      book.add({ id: this.d.newId(), product: p.product, kind: p.kind, side: p.side, qty: Math.abs(held), trigger: p.trigger!, createdAt: this.d.now() })
      this.set({ status: 'placed', p, affected: 1 })
      // The market may already be through the trigger (it moved during the 5 s window): fire now, not on the next tick.
      await this.onQuote(p.product)
      return
    }
    await this.execute(p)
  }

  /** One market IOC order, then book the fill at the execution-time bid/ask and re-fit resting orders. */
  private async execute(p0: Proposal) {
    // Clamp to the live position: an order armed before another fill must never flip or open a position.
    const held = this.d.ledger.qty(p0.product)
    if (!held || (held > 0 ? 'SELL' : 'BUY') !== p0.side) { this.set({ status: 'failed', p: p0, reason: 'position already closed' }); return }
    const qty = Math.min(p0.qty, Math.abs(held))
    const p: Proposal = { ...p0, qty, exposureBefore: held, exposureAfter: round12(held - Math.sign(held) * qty) }
    this.set({ status: 'sending', p })
    const res = await this.d.placeOrder({
      client_order_id: p.id,
      product_id: p.product,
      side: p.side,
      order_configuration: { market_market_ioc: { base_size: baseSize(p.qty) } },
    })
    if (!res.ok) { this.set({ status: 'failed', p, reason: res.reason }); return }
    const q = this.d.quote(p.product)
    const price = q ? (p.side === 'SELL' ? q.bid : q.ask) : p.estPrice
    const fill = this.d.ledger.apply({ id: p.id, product: p.product, side: p.side, qty: p.qty, price, t: this.d.now() })
    this.d.book.reconcile(p.product, this.d.ledger.qty(p.product))
    this.d.onFill(fill)
    this.set({ status: 'filled', p, fill, orderId: res.orderId })
  }

  private propose(p: Proposal): Proposal {
    this.set({ status: 'proposed', p })
    return p
  }

  private set(s: ActionState): ActionState {
    this.states.set(s.p.id, s)
    this.d.onChange(s)
    return s
  }
}
