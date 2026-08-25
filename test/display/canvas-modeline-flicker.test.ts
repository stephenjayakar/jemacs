/**
 * Reproduces the reported flicker.
 *
 * `patchPane` falls back to a full `fillPane` rebuild whenever the body *and* the
 * modeline both changed. A modeline shows the cursor position and buffer state, so it
 * changes on essentially every frame -- meaning any animating surface takes the rebuild
 * path, and `fillPane` strips the surface classes and re-renders from scratch.
 *
 * Earlier probes missed this because they re-serialized the same buffer without touching
 * the modeline, so `modelineChanged` stayed false and the patch path was taken.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Window } from "happy-dom"

const window = new Window({ url: "http://localhost" })
const globals = globalThis as Record<string, unknown>
globals.window = window
globals.document = window.document
globals.HTMLElement = window.HTMLElement
globals.HTMLCanvasElement = window.HTMLCanvasElement
globals.requestAnimationFrame = (callback: FrameRequestCallback) => { void callback(0); return 0 }
globals.cancelAnimationFrame = () => {}

const { presentDomFrame } = await import("../../src/display/dom-frame")
const { serializeDisplayModel } = await import("../../src/display/serialize")
const { buildDisplayModel } = await import("../../src/display/build-display-model")
const { install: installCanvas } = await import("../../plugins/canvas-mode")
const { DEMOS } = await import("../../plugins/canvas-mode/demos")
const { makeEditor } = await import("../plugins/helper")
const { modes } = await import("../../src/modes/mode")

const CAPS = {
  unit: "pixels" as const,
  mouse: true,
  clipboard: true,
  osc52: false,
  richTables: true,
  webSurfaces: true,
}

function targets() {
  const make = () => window.document.createElement("div") as unknown as HTMLElement
  const root = make()
  const built = { title: make(), windows: make(), minibuffer: make(), echo: make() }
  root.append(built.title, built.windows, built.minibuffer, built.echo)
  window.document.body.appendChild(root as never)
  return built
}

beforeEach(() => { window.document.body.innerHTML = "" })
afterEach(() => { modes.delete("canvas") })

describe("surface survives a changing modeline", () => {
  test("canvas is not torn down when the modeline changes with the body", () => {
    const dom = targets()
    const editor = makeEditor()
    installCanvas(editor)
    const demo = DEMOS.find(d => d.name === "orbits")!
    const buffer = editor.scratch("*canvas: orbits*", demo.source, "canvas")
    editor.switchToBuffer(buffer.id)

    const frame = (t: number, message: string) => {
      buffer.locals.set("canvas-time", Math.round(t * 1000) / 1000)
      return serializeDisplayModel(buildDisplayModel(editor, {
        // A changing echo message is the cheapest way to make the modeline/footer
        // differ per frame, which is what the real editor does constantly.
        lastMessage: message,
        viewport: { rows: 24, cols: 100 },
        hostCapabilities: CAPS,
      }))
    }

    presentDomFrame(dom, frame(0, "frame 0"))
    const first = dom.windows.querySelector("canvas.web-surface-canvas")
    expect(first).not.toBeNull()

    const identities = new Set<unknown>([first])
    const missing: number[] = []
    for (let i = 1; i < 30; i++) {
      presentDomFrame(dom, frame(i * 0.1, `frame ${i}`))
      const el = dom.windows.querySelector("canvas.web-surface-canvas")
      if (!el) missing.push(i)
      identities.add(el)
    }

    expect(missing).toEqual([])
    // One identity across every frame. More means the element was recreated, which is
    // the visible flash.
    expect(identities.size).toBe(1)
  })

  test("cursor movement does not tear down the surface", () => {
    const dom = targets()
    const editor = makeEditor()
    installCanvas(editor)
    const demo = DEMOS.find(d => d.name === "grid")!
    const buffer = editor.scratch("*canvas: grid*", demo.source, "canvas")
    editor.switchToBuffer(buffer.id)

    const frame = () => serializeDisplayModel(buildDisplayModel(editor, {
      viewport: { rows: 24, cols: 100 },
      hostCapabilities: CAPS,
    }))

    presentDomFrame(dom, frame())
    const first = dom.windows.querySelector("canvas.web-surface-canvas")
    expect(first).not.toBeNull()

    // Move point: the modeline line/col changes, the drawing does not.
    const identities = new Set<unknown>([first])
    for (let i = 0; i < 20; i++) {
      buffer.point = Math.min(buffer.text.length, i * 3)
      presentDomFrame(dom, frame())
      identities.add(dom.windows.querySelector("canvas.web-surface-canvas"))
    }
    expect(identities.size).toBe(1)
  })
})
