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

import { randomUUID } from 'node:crypto'
import type { PaperLedger, Quote, Fill } from './ledger.ts'

export const UNDO_MS = 5000
export const PREVIEW_TTL_MS = 30_000
export const MAX_DRIFT = 0.01 // 1%

export type ActionKind = 'halve' | 'close'
export type Proposal = {
  id: string
  kind: ActionKind
  product: string
  side: 'BUY' | 'SELL'
  qty: number
  estPrice: number
  estFee: number
  estNet: number // cash in (+) or out (-) after fee
  exposureBefore: number
  exposureAfter: number
  createdAt: number
}
export type ActionState =
  | { status: 'proposed'; p: Proposal }
  | { status: 'armed'; p: Proposal; fireAt: number }
  | { status: 'undone'; p: Proposal }
  | { status: 'sending'; p: Proposal }
  | { status: 'filled'; p: Proposal; fill: Fill; orderId: string }
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

export type ActionDeps = {
  ledger: PaperLedger
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
      ...deps,
    }
  }

  get(id: string): ActionState | undefined { return this.states.get(id) }
  /** Armed actions still inside their undo window (the glasses show these as a countdown). */
  armed(): Extract<ActionState, { status: 'armed' }>[] {
    return [...this.states.values()].filter((s): s is Extract<ActionState, { status: 'armed' }> => s.status === 'armed')
  }

  preview(kind: ActionKind, product: string): Proposal {
    const { ledger } = this.d
    const q = this.d.quote(product)
    if (!q) throw new Error(`no live quote for ${product}`)
    const held = ledger.qty(product)
    if (!held) throw new Error(`no ${product} position`)
    const qtyAbs = kind === 'close' ? Math.abs(held) : Math.abs(held) / 2
    const side = held > 0 ? 'SELL' : 'BUY'
    const estPrice = side === 'SELL' ? q.bid : q.ask
    const notional = qtyAbs * estPrice
    const estFee = notional * ledger.feeRate
    const estNet = side === 'SELL' ? notional - estFee : -(notional + estFee)
    const after = held - Math.sign(held) * qtyAbs
    const p: Proposal = {
      id: this.d.newId(), kind, product, side, qty: qtyAbs, estPrice, estFee, estNet,
      exposureBefore: held, exposureAfter: Math.abs(after) < 1e-12 ? 0 : after, createdAt: this.d.now(),
    }
    this.set({ status: 'proposed', p })
    return p
  }

  /** Returns the state after the call. Confirming twice is a no-op (double-tap safe). */
  confirm(id: string): ActionState {
    const s = this.states.get(id)
    if (!s) throw new Error(`unknown action ${id}`)
    if (s.status !== 'proposed') return s
    const age = this.d.now() - s.p.createdAt
    if (age > PREVIEW_TTL_MS) return this.set({ status: 'failed', p: s.p, reason: 'preview expired, look again' })
    const q = this.d.quote(s.p.product)
    const px = q ? (s.p.side === 'SELL' ? q.bid : q.ask) : NaN
    if (!(px > 0)) return this.set({ status: 'failed', p: s.p, reason: 'no live quote' })
    if (Math.abs(px - s.p.estPrice) / s.p.estPrice > MAX_DRIFT) return this.set({ status: 'failed', p: s.p, reason: 'price moved >1%, look again' })
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

  private async fire(id: string) {
    const s = this.states.get(id)
    this.timers.delete(id)
    if (!s || s.status !== 'armed') return
    this.set({ status: 'sending', p: s.p })
    const res = await this.d.placeOrder({
      client_order_id: s.p.id,
      product_id: s.p.product,
      side: s.p.side,
      order_configuration: { market_market_ioc: { base_size: baseSize(s.p.qty) } },
    })
    if (!res.ok) { this.set({ status: 'failed', p: s.p, reason: res.reason }); return }
    const q = this.d.quote(s.p.product)
    const price = q ? (s.p.side === 'SELL' ? q.bid : q.ask) : s.p.estPrice
    const fill = this.d.ledger.apply({ id: s.p.id, product: s.p.product, side: s.p.side, qty: s.p.qty, price, t: this.d.now() })
    this.d.onFill(fill)
    this.set({ status: 'filled', p: s.p, fill, orderId: res.orderId })
  }

  private set(s: ActionState): ActionState {
    this.states.set(s.p.id, s)
    this.d.onChange(s)
    return s
  }
}
