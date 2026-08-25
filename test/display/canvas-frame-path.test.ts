/**
 * Drives the *whole* GUI path an animating canvas takes -- buildDisplayModel,
 * serializeDisplayModel, presentDomFrame -- across successive clock ticks, and asserts
 * the pane is patched in place rather than rebuilt.
 *
 * The earlier probes checked the model and the surface renderer in isolation and both
 * passed while the pane still flickered, so this covers the seam between them: which
 * branch `presentDomFrame` takes on frame two.
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

/** An editor showing the named demo in canvas mode, plus a frame(t) serializer. */
function canvasEditor(name: string) {
  const editor = makeEditor()
  installCanvas(editor)
  const demo = DEMOS.find(d => d.name === name)!
  const buffer = editor.scratch(`*canvas: ${name}*`, demo.source, "canvas")
  editor.switchToBuffer(buffer.id)
  return {
    editor,
    buffer,
    frame(t: number) {
      buffer.locals.set("canvas-time", Math.round(t * 1000) / 1000)
      return serializeDisplayModel(buildDisplayModel(editor, {
        viewport: { rows: 24, cols: 100 },
        hostCapabilities: CAPS,
      }))
    },
  }
}

beforeEach(() => { window.document.body.innerHTML = "" })
afterEach(() => { modes.delete("canvas") })

describe("canvas animation through the real GUI path", () => {
  test("the canvas element survives sixty animation frames", () => {
    const dom = targets()
    const { frame } = canvasEditor("orbits")

    presentDomFrame(dom, frame(0))
    const first = dom.windows.querySelector("canvas.web-surface-canvas")
    expect(first).not.toBeNull()

    const identities = new Set<unknown>([first])
    for (let i = 1; i < 60; i++) {
      presentDomFrame(dom, frame(i * 0.1))
      identities.add(dom.windows.querySelector("canvas.web-surface-canvas"))
    }
    // More than one identity means the element was recreated mid-animation, which is
    // what the user sees as flashing.
    expect(identities.size).toBe(1)
  })

  test("the pane never falls back to plain body rows mid-animation", () => {
    const dom = targets()
    const { frame } = canvasEditor("sine")

    const framesWithoutCanvas: number[] = []
    for (let i = 0; i < 60; i++) {
      presentDomFrame(dom, frame(i * 0.1))
      if (!dom.windows.querySelector("canvas.web-surface-canvas")) framesWithoutCanvas.push(i)
    }
    expect(framesWithoutCanvas).toEqual([])
  })

  test("the web-surface class stays on the body across frames", () => {
    const dom = targets()
    const { frame } = canvasEditor("bounce")

    const missing: number[] = []
    for (let i = 0; i < 40; i++) {
      presentDomFrame(dom, frame(i * 0.1))
      if (!dom.windows.querySelector(".web-surface")) missing.push(i)
    }
    expect(missing).toEqual([])
  })

  test("exactly one canvas and one root exist after many frames", () => {
    const dom = targets()
    const { frame } = canvasEditor("orbits")
    for (let i = 0; i < 40; i++) presentDomFrame(dom, frame(i * 0.1))
    expect(dom.windows.querySelectorAll("canvas.web-surface-canvas")).toHaveLength(1)
    expect(dom.windows.querySelectorAll(".web-surface-root")).toHaveLength(1)
  })
})
