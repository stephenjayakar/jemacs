/**
 * Dragging with the cursor in a GUI host must set the mark, so the swept text is
 * both `use-region-p` true for kill/copy and painted with the `region` face.
 *
 * The failure mode this pins: `drag` is dropped somewhere between the renderer's
 * mousemove and `editor.clickWindow`, so a sweep just walks point and nothing is
 * ever selected.
 */
import { describe, expect, test } from "bun:test"
import { runJemacsCore } from "../../src/run-core"
import { makeEditor } from "../plugins/helper"
import type { HostCapabilities, InputHandler, UiHost } from "../../src/display/protocol"

const NL = String.fromCharCode(10)

const GUI_CAPS: HostCapabilities = {
  unit: "pixels",
  mouse: true,
  clipboard: true,
  osc52: false,
  richTables: true,
  webSurfaces: true,
  perFaceFonts: true,
}

function guiHost(): { host: UiHost; input: () => InputHandler } {
  let handler: InputHandler = () => {}
  const host: UiHost = {
    label: "Jemacs GUI",
    capabilities: GUI_CAPS,
    async start() {},
    destroy() {},
    present() {},
    syncFrames(frames, render) { for (const frame of frames) render(frame.id) },
    getViewport: () => ({ rows: 30, cols: 100 }),
    onInput(h) { handler = h },
    onResize() {},
  }
  return { host, input: () => handler }
}

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))

describe("mouse drag marks the region", () => {
  test("press then drag activates the mark and selects the swept text", async () => {
    const editor = makeEditor()
    const text = Array.from({ length: 20 }, (_, i) => `line ${i} some words here`).join(NL)
    const buffer = editor.scratch("drag.txt", text, "text")
    editor.switchToBuffer(buffer.id)
    buffer.point = 0

    const { host, input } = guiHost()
    await runJemacsCore(editor, host)
    await settle()

    const windowId = editor.selectedWindowId
    await input()({ type: "mouse", windowId, row: 1, col: 2, button: 0 })
    await settle()
    const anchor = editor.currentBuffer.point
    expect(editor.currentBuffer.markActive).toBe(false)

    await input()({ type: "mouse", windowId, row: 3, col: 6, button: 0, drag: true })
    await settle()

    expect(editor.currentBuffer.markActive).toBe(true)
    expect(editor.currentBuffer.mark).toBe(anchor)
    expect(editor.currentBuffer.useRegion()).toBe(true)
    expect(editor.currentBuffer.point).toBeGreaterThan(anchor)
    expect(editor.currentBuffer.selectedText().length).toBeGreaterThan(0)
  })

  test("the swept text is painted with the region face", async () => {
    const editor = makeEditor()
    const buffer = editor.scratch("drag2.txt", `alpha${NL}beta${NL}gamma`, "text")
    editor.switchToBuffer(buffer.id)
    buffer.point = 0

    const { host, input } = guiHost()
    const binding = await runJemacsCore(editor, host)
    await settle()

    const windowId = editor.selectedWindowId
    await input()({ type: "mouse", windowId, row: 0, col: 1, button: 0 })
    await settle()
    await input()({ type: "mouse", windowId, row: 1, col: 3, button: 0, drag: true })
    await settle()

    const model = binding.modelFor()
    const pane = model.windows.kind === "leaf" ? model.windows.pane : null
    const regionBg = editor.theme.faces.region?.bg
    expect(regionBg).toBeTruthy()
    const painted = pane!.body.chunks.some(chunk => chunk.bg === regionBg)
    expect(painted).toBe(true)
  })
})
