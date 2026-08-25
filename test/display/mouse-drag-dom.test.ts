/**
 * The browser half of drag-to-select: a `mousedown` on a pane must start a
 * gesture that keeps emitting positions as the pointer moves, and stop on
 * `mouseup`. `test/display/mouse-drag-region.test.ts` covers the kernel half.
 *
 * happy-dom gives real event dispatch, so this exercises the same listeners the
 * Electron renderer registers.
 */
import { beforeEach, describe, expect, test } from "bun:test"
import { Window } from "happy-dom"
import type { SerializedDisplayModel, SerializedPane } from "../../src/display/serialize"

const window = new Window({ url: "http://localhost" })
const globals = globalThis as Record<string, unknown>
globals.window = window
globals.document = window.document
globals.HTMLElement = window.HTMLElement
globals.requestAnimationFrame = (cb: FrameRequestCallback) => { void cb(0); return 0 }
globals.cancelAnimationFrame = () => {}

const { presentDomFrame } = await import("../../src/display/dom-frame")

const NL = String.fromCharCode(10)
const themed = (text: string) => ({ chunks: [{ text }] })

function model(): SerializedDisplayModel {
  const pane: SerializedPane = {
    id: "w1", bufferId: "b1", selected: true, dedicated: false,
    body: themed(`alpha${NL}beta${NL}gamma`),
    cursor: { row: 0, colOffset: 0 },
    modeline: themed(" -:-- drag "),
    clickState: { startLine: 0, gutterPrefixLen: 0 },
    bodyLineBudget: 24, syncText: "", syncPoint: 0, textScale: 1,
  }
  return {
    title: themed("jemacs"), windows: { kind: "leaf", pane }, childFrames: [],
    minibufferCompletions: themed(""), minibufferCompletionLines: 0,
    minibuffer: themed(""), echo: themed(""),
    theme: { faces: { default: { fg: "#ddd", bg: "#111" } } } as never,
    viewport: { rows: 24, cols: 80 }, hostLabel: "test",
  }
}

function targets() {
  const make = () => window.document.createElement("div") as unknown as HTMLElement
  const built = { title: make(), windows: make(), minibuffer: make(), echo: make() }
  window.document.body.append(built.title as never, built.windows as never, built.minibuffer as never, built.echo as never)
  return built
}

/** happy-dom has no layout engine: every rect is 0x0, so without this every
 *  pixel would hit-test to the same cell. Stack the rendered rows 18px apart
 *  and let the fixed-grid column fallback do the rest. */
function layout(body: HTMLElement): void {
  const rows = [...body.querySelectorAll(".body-row")] as unknown as HTMLElement[]
  const rect = (top: number, height: number) => ({
    x: 0, y: top, left: 0, right: 800, top, bottom: top + height, width: 800, height,
    toJSON: () => ({}),
  }) as DOMRect
  body.getBoundingClientRect = () => rect(0, rows.length * 18)
  rows.forEach((row, i) => { row.getBoundingClientRect = () => rect(i * 18, 18) })
}

type MouseInit = { clientX: number; clientY: number; button?: number }
function fire(el: EventTarget, type: string, init: MouseInit): void {
  const ev = new window.MouseEvent(type, { bubbles: true, cancelable: true, ...init })
  el.dispatchEvent(ev as never)
}

beforeEach(() => { window.document.body.innerHTML = "" })

describe("mousedown starts a drag gesture", () => {
  test("press emits a click, moves emit drags, mouseup ends the stream", () => {
    const dom = targets()
    const events: Array<{ row: number; col: number; drag: boolean }> = []
    presentDomFrame(dom, model(), (_id, row, col, drag) => {
      events.push({ row, col, drag: drag === true })
    })
    const body = dom.windows.querySelector(".window-body")! as unknown as HTMLElement
    layout(body)

    fire(body, "mousedown", { clientX: 10, clientY: 4, button: 0 })
    expect(events.length).toBe(1)
    expect(events[0]!.drag).toBe(false)

    fire(window.document as never, "mousemove", { clientX: 40, clientY: 22 })
    fire(window.document as never, "mousemove", { clientX: 80, clientY: 40 })
    const dragged = events.filter(e => e.drag)
    expect(dragged.length).toBe(2)
    expect(dragged.at(-1)!.row).toBe(2)

    // After mouseup the gesture must be torn down: further motion is inert.
    fire(window.document as never, "mouseup", { clientX: 80, clientY: 40 })
    const after = events.length
    fire(window.document as never, "mousemove", { clientX: 120, clientY: 4 })
    expect(events.length).toBe(after)
  })

  test("a press with no motion emits exactly one non-drag event", () => {
    const dom = targets()
    const events: Array<boolean> = []
    presentDomFrame(dom, model(), (_id, _row, _col, drag) => { events.push(drag === true) })
    const body = dom.windows.querySelector(".window-body")! as unknown as HTMLElement
    layout(body)

    fire(body, "mousedown", { clientX: 10, clientY: 4, button: 0 })
    fire(window.document as never, "mouseup", { clientX: 10, clientY: 4 })
    expect(events).toEqual([false])
  })
})
