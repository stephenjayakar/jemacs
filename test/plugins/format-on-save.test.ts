import { describe, expect, test } from "bun:test"
import { formatterFor, resolveCommand, formatBuffer, type Formatter } from "../../plugins/format-on-save"
import { makeEditor } from "./helper"
import { setCustom } from "../../src/runtime/custom"
import { install as installFormatOnSave } from "../../plugins/format-on-save"

const FORMATTERS: Formatter[] = [
  { modes: ["go"], command: ["goimports"] },
  { modes: ["typescript", "javascript"], command: ["prettier", "--stdin-filepath"] },
]

describe("formatterFor", () => {
  test("matches on major mode", () => {
    expect(formatterFor("go", FORMATTERS)?.command).toEqual(["goimports"])
    expect(formatterFor("typescript", FORMATTERS)?.command[0]).toBe("prettier")
  })

  test("returns null for an unconfigured mode", () => {
    expect(formatterFor("markdown", FORMATTERS)).toBeNull()
  })
})

describe("resolveCommand", () => {
  test("appends the path after --stdin-filepath so prettier picks a parser", () => {
    const prettier = FORMATTERS[1]!
    expect(resolveCommand(prettier, "/tmp/a.ts")).toEqual([
      "prettier", "--stdin-filepath", "/tmp/a.ts",
    ])
  })

  test("drops the flag when the buffer has no file", () => {
    expect(resolveCommand(FORMATTERS[1]!, undefined)).toEqual(["prettier"])
  })

  test("leaves other commands untouched", () => {
    expect(resolveCommand(FORMATTERS[0]!, "/tmp/a.go")).toEqual(["goimports"])
  })

  test("does not mutate the configured formatter", () => {
    const prettier = FORMATTERS[1]!
    resolveCommand(prettier, "/tmp/a.ts")
    resolveCommand(prettier, "/tmp/b.ts")
    expect(prettier.command).toEqual(["prettier", "--stdin-filepath"])
  })
})

describe("formatBuffer", () => {
  test("is a no-op for a mode with no configured formatter", async () => {
    const editor = makeEditor()
    installFormatOnSave(editor)
    setCustom("format-on-save-formatters", FORMATTERS)
    const buffer = editor.currentBuffer
    buffer.replaceRange(0, buffer.text.length, "# notes")
    expect(await formatBuffer(editor, buffer)).toBe(false)
    expect(buffer.text).toBe("# notes")
  })

  test("a missing formatter binary reports but leaves the buffer intact", async () => {
    const editor = makeEditor()
    installFormatOnSave(editor)
    setCustom("format-on-save-formatters", [
      { modes: [editor.currentBuffer.mode], command: ["definitely-not-a-real-formatter-xyz"] },
    ])
    const buffer = editor.currentBuffer
    const before = "unchanged text"
    buffer.replaceRange(0, buffer.text.length, before)

    // Must resolve false rather than throwing: a failed format must never block a save.
    expect(await formatBuffer(editor, buffer)).toBe(false)
    expect(buffer.text).toBe(before)
  })

  test("runs a real filter and preserves point by line/column", async () => {
    const editor = makeEditor()
    installFormatOnSave(editor)
    const buffer = editor.currentBuffer
    // `sed` uppercases nothing here; `tr` is a stable, always-present filter.
    setCustom("format-on-save-formatters", [
      { modes: [buffer.mode], command: ["tr", "a-z", "A-Z"] },
    ])
    buffer.replaceRange(0, buffer.text.length, "one\ntwo\nthree\n")
    buffer.point = buffer.text.indexOf("wo")

    const changed = await formatBuffer(editor, buffer)
    expect(changed).toBe(true)
    expect(buffer.text).toBe("ONE\nTWO\nTHREE\n")
    // Point stays on line 1, column 1 -- the same place, not the same offset.
    expect(buffer.point).toBe(buffer.text.indexOf("WO"))
  })

  test("discards empty output rather than emptying the file", async () => {
    const editor = makeEditor()
    installFormatOnSave(editor)
    const buffer = editor.currentBuffer
    setCustom("format-on-save-formatters", [
      { modes: [buffer.mode], command: ["true"] },
    ])
    const before = "important content\n"
    buffer.replaceRange(0, buffer.text.length, before)

    expect(await formatBuffer(editor, buffer)).toBe(false)
    expect(buffer.text).toBe(before)
  })
})

describe("commands", () => {
  test("registers format-buffer and format-on-save-mode", () => {
    const editor = makeEditor()
    installFormatOnSave(editor)
    expect(editor.commands.get("format-buffer")).toBeDefined()
    expect(editor.commands.get("format-on-save-mode")).toBeDefined()
  })
})
