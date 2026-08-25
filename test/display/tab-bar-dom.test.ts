/**
 * The tab bar's DOM half: `presentDomFrame` must fill `#jemacs-tab-bar`, hide
 * it when the model carries no bar, and turn a click into a character column.
 *
 * A minimal DOM fake (the same approach as `test/bugs/loop-t-audit2-18e7a2c9`)
 * keeps this a unit test; the live Electron path is covered by the GUI smoke
 * run's "tab bar painted after Cmd-T" check.
 */
import { afterEach, expect, test } from "bun:test"
import type { SerializedDisplayModel, SerializedPane, SerializedThemedText } from "../../src/display/serialize"

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number }
const rect = (left: number, top: number, width: number, height: number): Rect =>
  ({ left, top, right: left + width, bottom: top + height, width, height })

type Listener = (ev: unknown) => void

class FakeText {
  nodeType = 3
  constructor(public data: string) {}
}

class FakeEl {
  nodeType = 1
  children: FakeEl[] = []
  childNodes: Array<FakeEl | FakeText> = []
  classList = new Set<string>()
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  _rect: Rect = rect(0, 0, 800, 18)
  _listeners: Record<string, Listener[]> = {}
  isConnected = true
  parentNode: FakeEl | null = null
  constructor(public tagName: string) {}
  set className(v: string) { this.classList = new Set(v.split(/\s+/).filter(Boolean)) }
  get className() { return [...this.classList].join(" ") }
  set textContent(v: string) { this.childNodes = [new FakeText(v)]; this.children = [] }
  get textContent(): string {
    return this.childNodes.map(n => n instanceof FakeText ? n.data : (n as FakeEl).textContent).join("")
  }
  appendChild<T extends FakeEl | FakeText>(c: T): T {
    this.childNodes.push(c)
    if (c instanceof FakeEl) { this.children.push(c); c.parentNode = this }
    return c
  }
  append(...cs: FakeEl[]) { for (const c of cs) this.appendChild(c) }
  replaceChildren(...cs: FakeEl[]) {
    this.children = []; this.childNodes = []
    for (const c of cs) this.appendChild(c)
  }
  remove() {}
  querySelectorAll(sel: string): FakeEl[] {
    const cls = sel.replace(/^\./, "")
    const out: FakeEl[] = []
    const walk = (el: FakeEl) => {
      if (el.classList.has(cls)) out.push(el)
      for (const c of el.children) walk(c)
    }
    for (const c of this.children) walk(c)
    return out
  }
  addEventListener(ev: string, fn: Listener) { (this._listeners[ev] ??= []).push(fn) }
  getBoundingClientRect() { return this._rect }
  scrollIntoView() {}
}

const saved: Record<string, unknown> = {}
function stub(key: string, value: unknown) {
  if (!(key in saved)) saved[key] = (globalThis as Record<string, unknown>)[key]
  ;(globalThis as Record<string, unknown>)[key] = value
}

function installDom(): void {
  stub("document", {
    documentElement: new FakeEl("html"),
    body: new FakeEl("body"),
    getElementById: () => null,
    createElement: (tag: string) => new FakeEl(tag),
    // No createRange: `charOffsetAtX` then falls back to the fixed 9px grid,
    // which is the right model for a monospace tab bar anyway.
  })
}
afterEach(() => { for (const [key, value] of Object.entries(saved)) (globalThis as Record<string, unknown>)[key] = value })

const themed = (text: string): SerializedThemedText => ({ chunks: [{ text }] })

const pane: SerializedPane = {
  id: "w1", bufferId: "b1", selected: true, dedicated: false,
  body: themed("hello"), modeline: themed(" -:-- "),
  clickState: { startLine: 0, gutterPrefixLen: 0 },
  bodyLineBudget: 24, syncText: "", syncPoint: 0, textScale: 1,
}

function model(tabBar?: SerializedThemedText): SerializedDisplayModel {
  return {
    title: themed("jemacs"),
    tabBar,
    windows: { kind: "leaf", pane },
    childFrames: [],
    minibufferCompletions: themed(""),
    minibufferCompletionLines: 0,
    minibuffer: themed(""),
    echo: themed(""),
    theme: { faces: { default: { fg: "#ddd", bg: "#111" } } } as never,
    viewport: { rows: 24, cols: 80 },
    hostLabel: "test",
  }
}

function targets() {
  const mk = () => new FakeEl("div")
  return { title: mk(), tabBar: mk(), windows: mk(), minibuffer: mk(), echo: mk(), minibufferCompletions: mk() }
}

test("the tab bar element carries the model's text and hides when there is none", async () => {
  installDom()
  const { presentDomFrame } = await import("../../src/display/dom-frame")
  const t = targets()

  presentDomFrame(t as never, model(themed("|a x|b x| + ")))
  expect(t.tabBar.textContent).toBe("|a x|b x| + ")
  expect(t.tabBar.style.display).toBe("")

  // A second frame with no bar must blank and hide it, not leave the old row up.
  presentDomFrame(t as never, model(undefined))
  expect(t.tabBar.textContent).toBe("")
  expect(t.tabBar.style.display).toBe("none")
})

test("a click on the bar reports the character column under the pointer", async () => {
  installDom()
  const { presentDomFrame, DOM_FRAME_COL_PX } = await import("../../src/display/dom-frame")
  const t = targets()
  const cols: number[] = []
  t.tabBar._rect = rect(0, 0, 800, 18)

  presentDomFrame(t as never, model(themed("|a x|b x| + ")), undefined, undefined, undefined, col => { cols.push(col) })
  const click = (clientX: number, button = 0) =>
    t.tabBar._listeners.mousedown![0]!({ button, clientX, clientY: 4, preventDefault() {} })

  click(DOM_FRAME_COL_PX * 1 + 2)
  click(DOM_FRAME_COL_PX * 5 + 2)
  expect(cols).toEqual([1, 5])

  // Right-click is not a tab action.
  click(DOM_FRAME_COL_PX * 2, 2)
  expect(cols).toHaveLength(2)
})

test("the click listener is attached once, not once per frame", async () => {
  installDom()
  const { presentDomFrame } = await import("../../src/display/dom-frame")
  const t = targets()
  const cols: number[] = []
  const render = () =>
    presentDomFrame(t as never, model(themed("|a x| + ")), undefined, undefined, undefined, col => { cols.push(col) })

  render()
  render()
  render()
  expect(t.tabBar._listeners.mousedown).toHaveLength(1)
  t.tabBar._listeners.mousedown![0]!({ button: 0, clientX: 10, clientY: 4, preventDefault() {} })
  // One listener, so one report \u2014 a per-frame listener would fire three times.
  expect(cols).toHaveLength(1)
})
