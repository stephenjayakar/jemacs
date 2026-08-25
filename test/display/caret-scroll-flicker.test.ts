/**
 * Bottom-of-buffer flicker.
 *
 * `renderCaret` appends an absolutely-positioned caret to the body and then calls
 * `scrollIntoView` on it, twice per frame (once inline, once inside a rAF). At the
 * bottom of a buffer the caret sits at or past the last row, so scrolling it into view
 * can change `scrollTop`, which moves the rows, which repositions the caret on the next
 * frame -- an oscillation the user sees as flicker.
 *
 * The invariant these tests pin is that a caret render must be *idempotent*: presenting
 * the same model twice must leave scroll position and caret geometry unchanged.
 */
import { beforeEach, describe, expect, test } from "bun:test"
import { Window } from "happy-dom"

const window = new Window({ url: "http://localhost" })
const globals = globalThis as Record<string, unknown>
globals.window = window
globals.document = window.document
globals.HTMLElement = window.HTMLElement
globals.HTMLCanvasElement = window.HTMLCanvasElement

// Queue rAFs instead of running them inline. The real renderer defers the second
// `place()` by a frame, and running it synchronously hides ordering bugs.
const rafQueue: FrameRequestCallback[] = []
globals.requestAnimationFrame = (cb: FrameRequestCallback) => {
  rafQueue.push(cb)
  return rafQueue.length
}
globals.cancelAnimationFrame = (id: number) => { delete rafQueue[id - 1] }
function flushRafs(): void {
  const pending = rafQueue.splice(0, rafQueue.length)
  for (const cb of pending) if (cb) cb(0)
}

const { renderCaret, renderBodyRows } = await import("../../src/display/dom-frame")

function body(): HTMLElement {
  const el = window.document.createElement("div") as unknown as HTMLElement
  el.className = "window-body"
  window.document.body.appendChild(el as never)
  return el
}

/** Themed text of `n` numbered lines. */
function lines(n: number) {
  const text = Array.from({ length: n }, (_, i) => `line ${i}`).join(chr10())
  return { chunks: [{ text }] }
}
function chr10() { return String.fromCharCode(10) }

beforeEach(() => {
  window.document.body.innerHTML = ""
  rafQueue.length = 0
})

describe("caret rendering at the bottom of a buffer", () => {
  test("only one caret exists after repeated renders", () => {
    const el = body()
    for (let i = 0; i < 10; i++) {
      const rows = renderBodyRows(el, lines(40) as never)
      renderCaret(el, rows, { row: 39, colOffset: 0 })
      flushRafs()
    }
    // renderBodyRows rebuilds the rows each call, so a leaked caret would accumulate.
    expect(el.querySelectorAll(".jemacs-caret")).toHaveLength(1)
  })

  test("caret geometry is stable across identical renders", () => {
    const el = body()
    const render = () => {
      const rows = renderBodyRows(el, lines(40) as never)
      renderCaret(el, rows, { row: 39, colOffset: 0 })
      flushRafs()
      const caret = el.querySelector(".jemacs-caret") as HTMLElement | null
      return { top: caret?.style.top, left: caret?.style.left }
    }
    const first = render()
    const second = render()
    const third = render()
    // Identical input must produce identical geometry; drift here is the flicker.
    expect(second).toEqual(first)
    expect(third).toEqual(first)
  })

  test("a stale rAF does not place a caret that was already removed", () => {
    const el = body()
    const rows = renderBodyRows(el, lines(10) as never)
    renderCaret(el, rows, { row: 9, colOffset: 0 })
    // Re-render before the queued rAF runs: the first caret is detached.
    const rows2 = renderBodyRows(el, lines(10) as never)
    renderCaret(el, rows2, { row: 9, colOffset: 0 })
    expect(() => flushRafs()).not.toThrow()
    expect(el.querySelectorAll(".jemacs-caret")).toHaveLength(1)
  })

  test("scrollTop does not drift when re-rendering the same view", () => {
    const el = body()
    const rows = renderBodyRows(el, lines(200) as never)
    renderCaret(el, rows, { row: 199, colOffset: 0 })
    flushRafs()
    const settled = el.scrollTop

    for (let i = 0; i < 5; i++) {
      const r = renderBodyRows(el, lines(200) as never)
      renderCaret(el, r, { row: 199, colOffset: 0 })
      flushRafs()
    }
    // Any drift means each frame scrolls a little further -- the visible jitter.
    expect(el.scrollTop).toBe(settled)
  })
})
