import { describe, expect, test } from "bun:test"
import { spans } from "../harness"
import { makeEditor } from "./helper"
import { HI_BLUE_FACE, HI_GREEN_FACE, HI_YELLOW_FACE, install } from "../../plugins/hi-lock"
import { getMode } from "../../src/modes/mode"

describe("hi-lock-mode", () => {
  test("highlight-regexp adds spans visible through the display harness", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*hi-lock*", "foo bar\nfoo baz\n", "text")

    await editor.run("highlight-regexp", ["foo", HI_YELLOW_FACE])

    expect(editor.isMinorModeEnabled("hi-lock-mode", buffer)).toBe(true)
    expect(spans(editor)).toContainEqual({ start: 0, end: 3, face: HI_YELLOW_FACE })
    expect(spans(editor)).toContainEqual({ start: 8, end: 11, face: HI_YELLOW_FACE })

    buffer.replaceRange(buffer.text.length, buffer.text.length, "tail foo\n")

    expect(spans(editor)).toContainEqual({ start: 21, end: 24, face: HI_YELLOW_FACE })
  })

  test("highlight-lines-matching-regexp highlights whole matching lines", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*hi-lock-lines*", "alpha\nbeta match\ngamma\n", "text")

    await editor.run("highlight-lines-matching-regexp", ["match", HI_GREEN_FACE])

    expect(spans(editor)).toContainEqual({ start: 6, end: 16, face: HI_GREEN_FACE })
    expect(spans(editor).some(span => span.start === 11 && span.end === 16 && span.face === HI_GREEN_FACE)).toBe(false)
  })

  test("unhighlight-regexp removes matching spans", async () => {
    const editor = makeEditor()
    install(editor)
    editor.scratch("*hi-lock-unhighlight*", "foo bar foo\n", "text")

    await editor.run("highlight-regexp", ["foo", HI_BLUE_FACE])
    expect(spans(editor).some(span => span.face === HI_BLUE_FACE)).toBe(true)

    await editor.run("unhighlight-regexp", ["foo"])

    expect(spans(editor).some(span => span.face === HI_BLUE_FACE)).toBe(false)
  })

  test("hi-lock-mode off suppresses existing highlights", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*hi-lock-toggle*", "foo\n", "text")

    await editor.run("highlight-regexp", ["foo", HI_YELLOW_FACE])
    expect(spans(editor)).toContainEqual({ start: 0, end: 3, face: HI_YELLOW_FACE })

    await editor.run("hi-lock-mode")

    expect(editor.isMinorModeEnabled("hi-lock-mode", buffer)).toBe(false)
    expect(spans(editor).some(span => span.face === HI_YELLOW_FACE)).toBe(false)

    await editor.run("hi-lock-mode")

    expect(spans(editor)).toContainEqual({ start: 0, end: 3, face: HI_YELLOW_FACE })
  })
})

describe("messages-buffer-mode", () => {
  test("messages buffer is read-only and has special-buffer keys", () => {
    const editor = makeEditor()
    install(editor)
    const buffer = [...editor.buffers.values()].find(buffer => buffer.kind === "messages")

    expect(buffer?.mode).toBe("messages-buffer-mode")
    expect(buffer?.readOnly).toBe(true)
    expect(getMode("messages-buffer-mode")?.keymap?.get("q")).toBe("quit-window")
    expect(getMode("messages-buffer-mode")?.keymap?.get("C-c C-c")).toBe("messages-buffer-noop")

    expect(() => buffer?.insert("x")).toThrow(/read-only/)
    buffer?.append("message\n")
    expect(buffer?.text).toContain("message")
  })
})
