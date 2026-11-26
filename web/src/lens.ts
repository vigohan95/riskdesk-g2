// A stand-in for the Even App bridge, so the unchanged glasses app (app/src/main.ts) runs in a normal browser tab.
// It draws the same text / image containers the glasses would get onto a 576x288 green-on-black "lens", and turns
// the buttons under it into the events the glasses would send (tap, double tap, long press, context menu).
//
// Text runs are placed at the x positions the firmware font gives (pretext's advance widths) and stretched to the
// firmware width of the run, so the space-padded right alignment the app computes for the real glasses lines up here
// too. The browser font is not the firmware font, so glyph shapes differ a little; the README screenshots are the real buffer.

import { getTextWidth } from '@evenrealities/pretext'

export const W = 576
export const H = 288
const LINE_H = 28
/** textColor 0-4 is the only emphasis on the panel: map it to green brightness. */
const GREEN = ['#0d3b14', '#1f6b2a', '#2fa043', '#45cc5c', '#7dff8f']

type Box = { id: number; name: string; x: number; y: number; w: number; h: number; pad: number; border: boolean; color: number; content: string }
type Img = { id: number; name: string; x: number; y: number; w: number; h: number; url: string | null }
type MenuItem = { itemID: number; itemName: string }
type Listener = (e: any) => void

/** Browser width of a run in the lens font (cached), to stretch it to the firmware width. */
const LENS_FONT = '20px "Segoe UI", system-ui, sans-serif'
let ctx: CanvasRenderingContext2D | null = null
const widths = new Map<string, number>()
function measure(t: string) {
  let w = widths.get(t)
  if (w === undefined) {
    ctx ??= document.createElement('canvas').getContext('2d')
    if (!ctx) return 0
    ctx.font = LENS_FONT
    w = ctx.measureText(t).width
    if (widths.size > 4000) widths.clear()
    widths.set(t, w)
  }
  return w
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

export class Lens {
  readonly el: HTMLElement
  private texts = new Map<number, Box>()
  private images = new Map<number, Img>()
  private menu: MenuItem[] = []
  private listeners: Listener[] = []
  private menuEl: HTMLElement | null = null
  private menuIdx = 0
  micOn = false
  onMic: ((on: boolean) => void) | null = null

  constructor(el: HTMLElement) {
    this.el = el
    el.style.cssText += `;position:relative;width:${W}px;height:${H}px;overflow:hidden;background:#000`
  }

  // ---------- the bridge surface main.ts uses ----------
  bridge() {
    const self = this
    return {
      async createStartUpPageContainer(p: any) { self.page(p); return 0 },
      async rebuildPageContainer(p: any) { self.page(p); return true },
      async textContainerUpgrade(u: any) {
        const b = self.texts.get(num(u.containerID))
        if (!b) return false
        if (typeof u.content === 'string') b.content = u.content
        if (typeof u.textColor === 'number') b.color = u.textColor
        self.render()
        return true
      },
      async updateImageRawData(u: any) {
        const img = self.images.get(num(u.containerID))
        if (!img) return 1
        const bytes = u.imageData instanceof Uint8Array ? u.imageData : Uint8Array.from(u.imageData as number[])
        if (img.url) URL.revokeObjectURL(img.url)
        img.url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
        self.render()
        return 0
      },
      onEvenHubEvent(fn: Listener) { self.listeners.push(fn); return () => { self.listeners = self.listeners.filter((l) => l !== fn) } },
      async audioControl(on: boolean) { self.micOn = on; self.onMic?.(on); return true },
      async shutDownPageContainer() { return true },
    }
  }

  private page(p: any) {
    this.texts.clear()
    for (const u of this.images.values()) if (u.url) URL.revokeObjectURL(u.url)
    this.images.clear()
    for (const t of p.textObject ?? []) {
      this.texts.set(num(t.containerID), {
        id: num(t.containerID), name: String(t.containerName ?? ''), x: num(t.xPosition), y: num(t.yPosition),
        w: num(t.width), h: num(t.height), pad: num(t.paddingLength), border: num(t.borderWidth) > 0,
        color: num(t.textColor, 4), content: String(t.content ?? ''),
      })
    }
    for (const i of p.imageObject ?? []) {
      this.images.set(num(i.containerID), { id: num(i.containerID), name: String(i.containerName ?? ''), x: num(i.xPosition), y: num(i.yPosition), w: num(i.width), h: num(i.height), url: null })
    }
    this.menu = (p.menuObject?.menuItems ?? []).map((m: any) => ({ itemID: num(m.itemID), itemName: String(m.itemName ?? '') }))
    this.closeMenu()
    this.render()
  }

  private render() {
    const frag = document.createDocumentFragment()
    for (const i of this.images.values()) {
      const d = document.createElement('img')
      d.style.cssText = `position:absolute;left:${i.x}px;top:${i.y}px;width:${i.w}px;height:${i.h}px;image-rendering:pixelated;filter:sepia(1) hue-rotate(70deg) saturate(6)`
      if (i.url) d.src = i.url
      d.alt = ''
      frag.append(d)
    }
    for (const b of this.texts.values()) {
      const box = document.createElement('div')
      const c = GREEN[Math.max(0, Math.min(4, b.color))]
      box.style.cssText = `position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;box-sizing:border-box;` +
        (b.border ? `border:1px solid ${GREEN[2]};border-radius:4px;` : '') + `color:${c};overflow:hidden`
      const inset = b.pad + (b.border ? 1 : 0)
      b.content.split('\n').forEach((line, row) => {
        // One span per run of text, placed at the firmware x and stretched to the firmware width of that run, so the
        // space-padded columns the app computes for the glasses line up here too, without per-glyph kerning gaps.
        // Runs break at 2+ spaces (column padding); single spaces inside a run stay ordinary word spaces.
        for (const m of line.matchAll(/\S+(?: \S+)*/g)) {
          const k = m.index ?? 0
          const run = m[0]
          const fw = getTextWidth(run)
          const bw = measure(run)
          const s = document.createElement('span')
          s.textContent = run
          s.style.cssText = `position:absolute;white-space:pre;left:${inset - (b.border ? 1 : 0) + getTextWidth(line.slice(0, k))}px;` +
            `top:${inset - (b.border ? 1 : 0) + row * LINE_H}px;line-height:${LINE_H}px;transform-origin:0 0;` +
            (bw > 0 && Math.abs(fw / bw - 1) > 0.01 ? `transform:scaleX(${(fw / bw).toFixed(3)})` : '')
          box.append(s)
        }
      })
      frag.append(box)
    }
    this.el.replaceChildren(frag)
    if (this.menuEl) this.el.append(this.menuEl)
  }

  // ---------- input ----------
  private emit(e: any) { for (const l of this.listeners) l(e) }
  tap() {
    if (this.menuEl) { const m = this.menu[this.menuIdx]; this.closeMenu(); if (m) this.emit({ menuItemClickEvent: { itemID: m.itemID } }); return }
    // CLICK_EVENT is 0, the protobuf default, so the host omits it (same shape the simulator sends)
    this.emit({ sysEvent: { eventSource: 1 } })
  }
  doubleTap() { if (this.menuEl) { this.closeMenu(); return } this.emit({ sysEvent: { eventType: 3 } }) }
  scroll(dir: 1 | -1) {
    if (this.menuEl) { this.menuIdx = (this.menuIdx + dir + this.menu.length) % this.menu.length; this.drawMenu(); return }
    this.emit({ sysEvent: { eventType: dir > 0 ? 2 : 1 } })
  }
  longPress() { this.emit({ sysEvent: { eventType: 9 } }) }
  release() { this.emit({ sysEvent: { eventType: 10 } }) }
  /** 100 ms of mic PCM (16 kHz s16le mono), the size the glasses deliver per event. */
  micChunk(pcm: Uint8Array) { if (this.micOn) this.emit({ audioEvent: { audioPcm: pcm } }) }

  get hasMenu() { return this.menu.length > 0 }
  get menuOpen() { return !!this.menuEl }
  openMenu() {
    if (!this.menu.length) return false
    this.menuIdx = 0
    this.menuEl = document.createElement('div')
    this.drawMenu()
    return true
  }
  clickMenuItem(i: number) { const m = this.menu[i]; this.closeMenu(); if (m) this.emit({ menuItemClickEvent: { itemID: m.itemID } }) }
  closeMenu() { this.menuEl?.remove(); this.menuEl = null; this.onMenu?.() }
  onMenu: (() => void) | null = null
  private drawMenu() {
    const m = this.menuEl!
    m.style.cssText = `position:absolute;inset:0;background:#000;color:${GREEN[4]};padding:6px 14px;box-sizing:border-box;line-height:${LINE_H - 2}px`
    const first = Math.max(0, Math.min(this.menuIdx - 4, this.menu.length - 10))
    m.replaceChildren(...this.menu.slice(first, first + 10).map((it, j) => {
      const d = document.createElement('div')
      const i = first + j
      d.textContent = (i === this.menuIdx ? '> ' : '   ') + it.itemName
      d.style.cssText = `cursor:pointer;white-space:nowrap;font-size:20px;color:${i === this.menuIdx ? GREEN[4] : GREEN[2]}`
      d.onclick = (ev) => { ev.stopPropagation(); this.clickMenuItem(i) }
      return d
    }))
    this.el.append(m)
    this.onMenu?.()
  }
}
