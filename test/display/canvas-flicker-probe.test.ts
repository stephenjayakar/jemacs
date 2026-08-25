/**
 * Drives the real canvas animation loop and checks the display model on every frame.
 *
 * `dom-frame` falls through to `renderBodyRows` whenever `model.webSurface` is absent,
 * and `safeWebSurface` swallows exceptions and returns undefined. So a surface that is
 * missing on *some* frames renders as the pane alternating between the drawing and plain
 * buffer text -- which is exactly the reported symptom.
 */
import { describe, expect, test } from "bun:test"
import { install as installCanvas, interpolate } from "../../plugins/canvas-mode"
import { parseCanvasProgram } from "../../plugins/canvas-mode/draw"
import { DEMOS } from "../../plugins/canvas-mode/demos"
import { buildDisplayModel } from "../../src/display/build-display-model"
import { makeEditor } from "../plugins/helper"

const CAPS = {
  unit: "pixels" as const,
  mouse: true,
  clipboard: true,
  osc52: false,
  richTables: true,
  webSurfaces: true,
}

function frameFor(editor: ReturnType<typeof makeEditor>) {
  return buildDisplayModel(editor, { viewport: { rows: 24, cols: 100 }, hostCapabilities: CAPS })
}

/** The pane showing the current buffer. */
function activePane(model: ReturnType<typeof buildDisplayModel>) {
  const panes: unknown[] = []
  const walk = (node: unknown) => {
    const n = node as { kind?: string; pane?: unknown; first?: unknown; second?: unknown }
    if (n?.pane) panes.push(n.pane)
    if (n?.first) walk(n.first)
    if (n?.second) walk(n.second)
  }
  walk((model as { windows?: unknown }).windows)
  return panes[0] as { webSurface?: unknown; body?: unknown } | undefined
}

describe("canvas animation frames", () => {
  test("every demo yields a surface at every clock tick", () => {
    for (const demo of DEMOS) {
      const editor = makeEditor()
      installCanvas(editor)
      const buffer = editor.scratch(`*canvas: ${demo.name}*`, demo.source, "canvas")
      editor.switchToBuffer(buffer.id)

      const missing: number[] = []
      // Same progression the animation timer produces: +0.1 per tick.
      for (let i = 0; i < 60; i++) {
        buffer.locals.set("canvas-time", Math.round(i * 0.1 * 1000) / 1000)
        const pane = activePane(frameFor(editor))
        if (!pane?.webSurface) missing.push(i)
      }
      expect({ demo: demo.name, missing }).toEqual({ demo: demo.name, missing: [] })
    }
  })

  test("the mode stays canvas across ticks", () => {
    const editor = makeEditor()
    installCanvas(editor)
    const demo = DEMOS.find(d => d.name === "sine")!
    const buffer = editor.scratch("*canvas: sine*", demo.source, "canvas")
    editor.switchToBuffer(buffer.id)

    const modes = new Set<string>()
    for (let i = 0; i < 30; i++) {
      buffer.locals.set("canvas-time", i * 0.1)
      frameFor(editor)
      modes.add(buffer.mode)
    }
    expect([...modes]).toEqual(["canvas"])
  })

  test("interpolation never produces an unparseable program", () => {
    for (const demo of DEMOS) {
      for (let i = 0; i < 120; i++) {
        const t = Math.round(i * 0.1 * 1000) / 1000
        const program = parseCanvasProgram(interpolate(demo.source, t))
        expect({ demo: demo.name, t, errors: program.errors.map(e => e.message) })
          .toEqual({ demo: demo.name, t, errors: [] })
      }
    }
  })

  test("shape count is stable across frames, so the drawing does not blink out", () => {
    for (const demo of DEMOS.filter(d => d.animated)) {
      const counts = new Set<number>()
      for (let i = 0; i < 60; i++) {
        const program = parseCanvasProgram(interpolate(demo.source, i * 0.1))
        counts.add(program.shapes.length)
      }
      // A varying shape count means some frames drop geometry entirely.
      expect({ demo: demo.name, counts: [...counts] })
        .toEqual({ demo: demo.name, counts: [...counts].slice(0, 1) })
    }
  })
})
