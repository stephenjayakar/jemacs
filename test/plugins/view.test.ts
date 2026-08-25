import { describe, expect, test } from "bun:test"
import { findWindowLeaf } from "../../src/kernel/window"
import { install } from "../../plugins/view"
import { makeEditor } from "./helper"

function setup(text = "one\ntwo\nthree\n") {
  const editor = makeEditor()
  install(editor)
  const buffer = editor.scratch("view.txt", text, "text")
  buffer.point = 0
  return { editor, buffer }
}

describe("view-mode", () => {
  test("enabling makes buffer read-only and q restores prior state", async () => {
    const { editor, buffer } = setup()
    expect(buffer.readOnly).toBe(false)

    await editor.run("view-mode")
    expect(editor.isMinorModeEnabled("view-mode", buffer)).toBe(true)
    expect(buffer.readOnly).toBe(true)

    await editor.handleKey({ name: "q", sequence: "q" })
    expect(editor.isMinorModeEnabled("view-mode", buffer)).toBe(false)
    expect(buffer.readOnly).toBe(false)
  })

  test("q restores buffers that were already read-only", async () => {
    const { editor, buffer } = setup()
    buffer.readOnly = true

    await editor.run("view-mode")
    await editor.handleKey({ name: "q", sequence: "q" })

    expect(editor.isMinorModeEnabled("view-mode", buffer)).toBe(false)
    expect(buffer.readOnly).toBe(true)
  })

  test("SPC scrolls through the view-mode keymap", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n")
    const { editor, buffer } = setup(lines)
    editor.lastViewport = { rows: 12 }

    await editor.run("view-mode")
    const before = findWindowLeaf(editor.windowLayout, editor.selectedWindowId)!.startLine
    const result = await editor.handleKey({ name: "space", sequence: " " })
    const after = findWindowLeaf(editor.windowLayout, editor.selectedWindowId)!.startLine

    expect(result).toEqual({ status: "command", command: "scroll-up-command" })
    expect(after).toBeGreaterThan(before)
    expect(buffer.point).toBeGreaterThan(0)
  })
})
