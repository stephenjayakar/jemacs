/**
 * html-mode renders through the same web-surface path canvas-mode uses, but had no
 * DOM-level coverage of its own.
 *
 * Two ways the rendered document can flash, both covered here:
 *
 *   1. The model stops carrying `webSurface` on some frame, so `fillPane` falls through
 *      to `renderBodyRows` and the pane shows raw HTML source for a frame. That is what a
 *      second, capability-less model build per redisplay caused.
 *
 *   2. `presentDomFrame` tears down and rebuilds the surface subtree instead of patching
 *      it, so the browser paints an empty pane between removal and insertion.
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
const { install: installHtml } = await import("../../plugins/html-mode")
const { HTML_DEMOS } = await import("../../plugins/html-mode/demos")
const { makeEditor } = await import("../plugins/helper")
const { modes } = await import("../../src/modes/mode")

const CAPS = {
  unit: "pixels" as const,
  mouse: true,
  clipboard: true,
  osc52: false,
  richTables: true,
  webSurfaces: true,
  perFaceFonts: true,
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
afterEach(() => { modes.delete("html-render") })

function htmlEditor(source: string) {
  const editor = makeEditor()
  installHtml(editor)
  const buffer = editor.scratch("page.html", source, "html-render")
  editor.switchToBuffer(buffer.id)
  return { editor, buffer }
}

describe("html-mode renders without flicker", () => {
  test("the surface subtree survives repeated presents", () => {
    const dom = targets()
    const demo = HTML_DEMOS[0]!
    const { editor, buffer } = htmlEditor(demo.source)

    const frame = (message: string) => serializeDisplayModel(buildDisplayModel(editor, {
      // A changing echo message is what the real editor produces constantly, and it
      // is what pushes `patchPane` onto its full-rebuild path.
      lastMessage: message,
      viewport: { rows: 30, cols: 110 },
      hostCapabilities: CAPS,
    }))

    presentDomFrame(dom, frame("frame 0"))
    const first = dom.windows.querySelector(".web-surface-root")
    expect(first).not.toBeNull()

    const identities = new Set<unknown>([first])
    const missing: number[] = []
    for (let i = 1; i < 20; i++) {
      // Move point so the modeline column changes, as it does while reading.
      buffer.point = Math.min(buffer.text.length, i * 5)
      presentDomFrame(dom, frame(`frame ${i}`))
      const root = dom.windows.querySelector(".web-surface-root")
      if (!root) missing.push(i)
      identities.add(root)
    }

    // Never absent: an absent root is a frame of raw HTML source.
    expect(missing).toEqual([])
    // Never recreated: a new element is a frame of empty pane.
    expect(identities.size).toBe(1)
  })

  test("every demo keeps its surface across frames", () => {
    for (const demo of HTML_DEMOS) {
      const { editor } = htmlEditor(demo.source)
      const missing: number[] = []
      for (let i = 0; i < 10; i++) {
        const model = buildDisplayModel(editor, {
          lastMessage: `frame ${i}`,
          viewport: { rows: 30, cols: 110 },
          hostCapabilities: CAPS,
        })
        const serialized = serializeDisplayModel(model)
        const pane = serialized.windows.kind === "leaf" ? serialized.windows.pane : undefined
        if (!pane?.webSurface) missing.push(i)
      }
      expect({ demo: demo.name, missing }).toEqual({ demo: demo.name, missing: [] })
      modes.delete("html-render")
    }
  })

  test("the rendered surface is stable when nothing changes", () => {
    const { editor } = htmlEditor(HTML_DEMOS[0]!.source)
    const frames: string[] = []
    for (let i = 0; i < 6; i++) {
      frames.push(JSON.stringify(serializeDisplayModel(buildDisplayModel(editor, {
        viewport: { rows: 30, cols: 110 },
        hostCapabilities: CAPS,
      }))))
    }
    expect(new Set(frames).size).toBe(1)
  })

  /**
   * The discriminating case: what a second, capability-less render path does to the DOM.
   *
   * The tests above all build through one consistent path, so they pass whether or not
   * the redisplay loop is correct -- they are coverage, not verification. This one
   * reproduces the actual defect by feeding `presentDomFrame` the capability-less model
   * the duplicate path produced, and pins that it swaps the rendered document for raw
   * HTML source. That is the frame the user sees as a flash.
   */
  test("a capability-less frame swaps the surface for source text", () => {
    const dom = targets()
    const { editor } = htmlEditor(HTML_DEMOS[0]!.source)

    const build = (withCaps: boolean) => serializeDisplayModel(buildDisplayModel(editor, {
      lastMessage: "",
      viewport: { rows: 30, cols: 110 },
      hostCapabilities: withCaps ? CAPS : undefined,
    }))

    const hasSurface = () => dom.windows.querySelector(".web-surface-root") !== null
    const hasSourceText = () => dom.windows.querySelector(".window-body > .body-row") !== null

    // The single correct path: surface every frame, fallback text never.
    const surfaceSeen: boolean[] = []
    const textSeen: boolean[] = []
    for (let i = 0; i < 8; i++) {
      presentDomFrame(dom, build(true))
      surfaceSeen.push(hasSurface())
      textSeen.push(hasSourceText())
    }
    expect(surfaceSeen).toEqual(Array(8).fill(true))
    expect(textSeen).toEqual(Array(8).fill(false))

    // Proof the assertions above discriminate: the model the duplicate path built
    // tears the surface out and paints source text in its place.
    presentDomFrame(dom, build(false))
    expect(hasSurface()).toBe(false)
    expect(hasSourceText()).toBe(true)

    // And the interleaving the bug actually produced: surface, source, surface, source.
    const alternating: boolean[] = []
    for (let i = 0; i < 6; i++) {
      presentDomFrame(dom, build(i % 2 === 0))
      alternating.push(hasSurface())
    }
    expect(alternating).toEqual([true, false, true, false, true, false])
  })
})
