/**
 * Input handling depends on the model the host most recently painted.
 *
 * `onInput` maps a mouse click to a buffer offset via `pane.clickState`, which only
 * exists on a built `DisplayModel` -- the kernel cannot recover it. So the binding has to
 * retain whatever it last built, for every frame it built it for.
 *
 * This is easy to break when the redisplay path changes: a multi-frame host paints
 * through `syncFrames`, so if only `present` records the model, the retained model is
 * never populated and the first click in the GUI dereferences nothing.
 */
import { describe, expect, test } from "bun:test"
import { runJemacsCore } from "../../src/run-core"
import { makeEditor } from "../plugins/helper"
import type { DisplayModel, HostCapabilities, UiHost } from "../../src/display/protocol"
import type { Editor } from "../../src/kernel/editor"
import type { InputHandler } from "../../src/display/protocol"

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

/** A host that paints only through `syncFrames`, exactly as the Electron GUI does. */
function multiFrameHost(): { host: UiHost; input: () => InputHandler } {
  let handler: InputHandler = () => {}
  const host: UiHost = {
    label: "Jemacs GUI",
    capabilities: GUI_CAPS,
    async start() {},
    destroy() {},
    present() {
      throw new Error("a multi-frame host must not be painted through present()")
    },
    syncFrames(frames, render) {
      for (const frame of frames) render(frame.id)
    },
    getViewport: () => ({ rows: 30, cols: 100 }),
    onInput(h) { handler = h },
    onResize() {},
  }
  return { host, input: () => handler }
}

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))

function textBuffer(editor: Editor, lines: number) {
  const text = Array.from({ length: lines }, (_, i) => `line ${i} some clickable words here`).join(NL)
  const buffer = editor.scratch("clickable.txt", text, "text")
  editor.switchToBuffer(buffer.id)
  return buffer
}

describe("input works after a syncFrames-only redisplay", () => {
  test("a mouse click resolves to a point instead of throwing", async () => {
    const editor = makeEditor()
    const buffer = textBuffer(editor, 200)
    buffer.point = 0

    const { host, input } = multiFrameHost()
    await runJemacsCore(editor, host)
    await settle()

    // Click row 3, column 5 of the selected window -- the same payload the Electron
    // renderer sends from its `mousedown` listener.
    await input()({ type: "mouse", windowId: editor.selectedWindowId, row: 3, col: 5, button: 0 })

    // A click that lands nowhere leaves point at 0; a working click moves it onto row 3.
    expect(editor.currentBuffer.point).toBeGreaterThan(0)
    expect(editor.currentBuffer.lineAt(editor.currentBuffer.point)).toBe(3)
  })

  test("a wheel scroll moves the viewport", async () => {
    const editor = makeEditor()
    const buffer = textBuffer(editor, 400)
    buffer.point = 0

    const { host, input } = multiFrameHost()
    await runJemacsCore(editor, host)
    await settle()

    const before = editor.selectedWindowLeaf()?.startLine ?? 0
    await input()({ type: "wheel", windowId: editor.selectedWindowId, lines: 5 })
    await settle()

    expect(editor.selectedWindowLeaf()?.startLine).toBeGreaterThan(before)
  })

  test("clicks keep working across successive redisplays", async () => {
    const editor = makeEditor()
    const buffer = textBuffer(editor, 200)

    const { host, input } = multiFrameHost()
    await runJemacsCore(editor, host)

    for (const row of [2, 5, 9]) {
      await editor.changed("between clicks")
      await settle()
      await input()({ type: "mouse", windowId: editor.selectedWindowId, row, col: 4, button: 0 })
      const startLine = editor.selectedWindowLeaf()?.startLine ?? 0
      expect(editor.currentBuffer.lineAt(editor.currentBuffer.point)).toBe(startLine + row)
    }
  })
})
