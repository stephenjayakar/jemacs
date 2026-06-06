import { describe, expect, test } from "bun:test"
import { Editor, type CompletingReadFunction, type MinibufferCompletionFrontend } from "../../src/kernel/editor"

// Merged-batch tests for the editor.ts sweep anchored on t-d8d557e9.
// Dead-state removal (tilingLayout, get windows/selectedWindow) is covered by
// the migrated callers compiling; these cover the behavioural fixes.

import { makeEditor } from "../plugins/helper"

describe("t-6d222ddb: completing-read / frontend stacks", () => {
  test("push/pop by identity tolerates out-of-order disable", () => {
    const editor = makeEditor()
    const a: CompletingReadFunction = async () => "a"
    const b: CompletingReadFunction = async () => "b"
    editor.pushCompletingReadFunction(a)
    editor.pushCompletingReadFunction(b)
    expect(editor.completingReadFunction).toBe(b)
    editor.popCompletingReadFunction(a) // disable A while B is on top
    expect(editor.completingReadFunction).toBe(b)
    editor.popCompletingReadFunction(b)
    expect(editor.completingReadFunction).toBeNull()
  })

  test("frontend stack mirrors the same semantics", () => {
    const editor = makeEditor()
    const a: MinibufferCompletionFrontend = {}
    const b: MinibufferCompletionFrontend = {}
    editor.pushMinibufferCompletionFrontend(a)
    editor.pushMinibufferCompletionFrontend(b)
    editor.popMinibufferCompletionFrontend(a)
    expect(editor.minibufferCompletionFrontend).toBe(b)
    editor.popMinibufferCompletionFrontend(b)
    expect(editor.minibufferCompletionFrontend).toBeNull()
  })

  test("legacy direct assignment still reads back as the active value", () => {
    const editor = makeEditor()
    const fn: CompletingReadFunction = async () => "x"
    editor.completingReadFunction = fn
    expect(editor.completingReadFunction).toBe(fn)
    editor.completingReadFunction = null
    expect(editor.completingReadFunction).toBeNull()
  })
})

describe("t-76a7fc8b: isearch fallthrough", () => {
  test("a non-isearch command pressed during isearch ends the search even if it throws", async () => {
    const editor = makeEditor()
    editor.command("boom", () => { throw new Error("boom") })
    editor.defineKey("global-map", "C-a", "boom")
    editor.scratch("buf", "alpha beta", "text")
    editor.startIsearch(1)
    expect(editor.isearch).not.toBeNull()
    await expect(editor.handleKey({ name: "a", ctrl: true })).rejects.toThrow("boom")
    expect(editor.isearch).toBeNull()
  })

  test("a non-isearch command that succeeds also ends the search", async () => {
    const editor = makeEditor()
    editor.command("noop", () => {})
    editor.defineKey("global-map", "C-e", "noop")
    editor.scratch("buf", "alpha beta", "text")
    editor.startIsearch(1)
    await editor.handleKey({ name: "e", ctrl: true })
    expect(editor.isearch).toBeNull()
  })

  test("an isearch-* command keeps the search active", async () => {
    const editor = makeEditor()
    editor.command("isearch-forward", () => editor.isearchRepeat())
    editor.defineKey("global-map", "C-s", "isearch-forward")
    editor.scratch("buf", "foo bar foo", "text")
    editor.startIsearch(1)
    await editor.handleKey({ name: "f", sequence: "f" })
    await editor.handleKey({ name: "s", ctrl: true })
    expect(editor.isearch).not.toBeNull()
  })
})

describe("t-92e15670 + t-87311a94: search ring and C-w yank", () => {
  test("C-s C-s with empty string recalls the previous search", async () => {
    const editor = makeEditor()
    const buf = editor.scratch("buf", "foo bar foo", "text")
    editor.startIsearch(1)
    await editor.handleKey({ name: "f", sequence: "f" })
    await editor.handleKey({ name: "o", sequence: "o" })
    await editor.handleKey({ name: "o", sequence: "o" })
    expect(editor.isearch?.string).toBe("foo")
    editor.endIsearch()

    buf.point = 0
    editor.startIsearch(1)
    expect(editor.isearch?.string).toBe("")
    editor.isearchRepeat()
    expect(editor.isearch?.string).toBe("foo")
    expect(buf.point).toBe(0) // first match at start
  })

  test("C-w during isearch yanks the word after the current match", async () => {
    const editor = makeEditor()
    const buf = editor.scratch("buf", "alpha beta gamma", "text")
    buf.point = 0
    editor.startIsearch(1)
    await editor.handleKey({ name: "a", sequence: "a" })
    await editor.handleKey({ name: "l", sequence: "l" })
    expect(editor.isearch?.string).toBe("al")
    await editor.handleKey({ name: "w", ctrl: true })
    expect(editor.isearch?.string).toBe("alpha")
    await editor.handleKey({ name: "w", ctrl: true })
    expect(editor.isearch?.string).toBe("alpha beta")
  })
})

describe("t-d6764d7a: prompt() cleanup", () => {
  test("depth and buffer are released via the resolve path; depth never goes negative", async () => {
    const editor = makeEditor()
    const buffersBefore = editor.buffers.size
    const p = editor.prompt("Test: ")
    expect(editor.minibufferDepthLevel).toBe(1)
    editor.minibufferCancel()
    expect(await p).toBeNull()
    expect(editor.minibufferDepthLevel).toBe(0)
    expect(editor.minibuffer).toBeNull()
    expect(editor.buffers.size).toBe(buffersBefore)
  })
})
