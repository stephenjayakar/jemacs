import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { TextareaRenderable } from "@opentui/core"
import { buildDisplayModel } from "../src/display/build-display-model"
import { Editor } from "../src/kernel/editor"
import { installDefaultConfig } from "../src/config"
import { defineMode } from "../src/modes/mode"
import { OpenTuiHost } from "../src/ui/opentui-host"

test("TextareaRenderable sync keeps multiline font-lock highlights aligned", async () => {
  const prev = process.env.JEMACS_USE_TEXTAREA
  process.env.JEMACS_USE_TEXTAREA = "1"
  try {
    defineMode({ name: "textarea-highlight-test", fontLock: () => [{ start: 12, end: 20, face: "keyword" }] })
    const editor = new Editor()
    installDefaultConfig(editor)
    editor.scratch("hl", "const x = 1\nfunction hi() {}\n", "textarea-highlight-test")

    const { renderer, renderOnce } = await createTestRenderer({ width: 80, height: 24 })
    const model = buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 24, cols: 80 } })
    const host = await OpenTuiHost.forRenderer(renderer)
    host.present(model)
    await renderOnce()

    const body = renderer.root.findDescendantById(`window-body:${editor.selectedWindowId}`) as TextareaRenderable
    expect(body.editBuffer.getLineHighlights(1).map(({ start, end }) => ({ start, end }))).toEqual([
      { start: 0, end: 8 },
      { start: 8, end: 16 },
    ])
    host.destroy()
  } finally {
    if (prev === undefined) delete process.env.JEMACS_USE_TEXTAREA
    else process.env.JEMACS_USE_TEXTAREA = prev
  }
})
