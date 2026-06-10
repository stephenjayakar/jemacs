import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { MarkdownRenderable, ScrollBoxRenderable } from "@opentui/core"
import { buildDisplayModel } from "../src/display/build-display-model"
import { themedTextPlain } from "../src/display/themed-text"
import { Editor } from "../src/kernel/editor"
import { installDefaultConfig } from "../src/config"
import { installDefaultModes } from "../src/modes/default-modes"
import { OpenTuiHost } from "../src/ui/opentui-host"
import { install as installMarkdown } from "../plugins/markdown"

test("OpenTuiHost present renders buffer text in test terminal", async () => {
  installDefaultModes()
  const editor = new Editor()
  installDefaultConfig(editor)
  editor.scratch("host-test", "visible-body-text", "text")

  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: 80,
    height: 24,
  })

  const model = buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 24, cols: 80 } })
  const host = await OpenTuiHost.forRenderer(renderer)
  host.present(model)
  await renderOnce()
  expect(captureCharFrame()).toContain("isible-body-text")
  host.destroy()
})

test("split window produces split display node", async () => {
  installDefaultModes()
  const editor = new Editor()
  installDefaultConfig(editor)
  editor.scratch("a", "aaa", "text")
  await editor.run("split-window-below")
  const model = buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 30, cols: 80 } })
  expect(model.windows.kind).toBe("split")
})

test("buildDisplayModel modeline includes mode name", () => {
  installDefaultModes()
  const editor = new Editor()
  installDefaultConfig(editor)
  editor.scratch("ml", "x", "text")
  const model = buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 24 } })
  const leaf = model.windows.kind === "leaf" ? model.windows.pane : null
  expect(themedTextPlain(leaf!.modeline)).toContain("text")
})

test("OpenTuiHost uses MarkdownRenderable for opentui markdown mode", async () => {
  installDefaultModes()
  const editor = new Editor()
  installDefaultConfig(editor)
  installMarkdown(editor)
  const buffer = editor.scratch("doc.md", "# Title\n\n| A | B |\n| - | - |\n| 1 | 2 |\n", "markdown")
  editor.enterMode(buffer, "opentui-markdown-mode")

  const { renderer, renderOnce } = await createTestRenderer({ width: 80, height: 24 })
  const model = buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 24, cols: 80 } })
  const leaf = model.windows.kind === "leaf" ? model.windows.pane : null
  expect(leaf?.markdownSurface?.content).toContain("| A | B |")

  const host = await OpenTuiHost.forRenderer(renderer)
  host.present(model)
  await renderOnce()

  const body = renderer.root.findDescendantById(`window-body:${editor.selectedWindowId}`)
  expect(body).toBeInstanceOf(ScrollBoxRenderable)
  const markdown = renderer.root.findDescendantById(`window-markdown:${editor.selectedWindowId}`)
  expect(markdown).toBeInstanceOf(MarkdownRenderable)
  host.destroy()
})
