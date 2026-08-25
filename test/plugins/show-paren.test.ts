import { describe, expect, test } from "bun:test"
import { makeEditor } from "./helper"
import { install, showParenCompute, showParenData, showParenSpans, SHOW_PAREN_LOCAL } from "../../plugins/show-paren"
import { setCustom } from "../../src/runtime/custom"

describe("showParenCompute", () => {
  test("point on opener scans forward to matching closer", () => {
    const text = "(foo bar)"
    const data = showParenCompute(text, 0)
    expect(data).toEqual({ hereBeg: 0, hereEnd: 1, thereBeg: 8, thereEnd: 9, mismatch: false })
  })

  test("point after closer scans backward to matching opener", () => {
    const text = "(foo bar)"
    const data = showParenCompute(text, 9)
    expect(data).toEqual({ hereBeg: 8, hereEnd: 9, thereBeg: 0, thereEnd: 1, mismatch: false })
  })

  test("nested parens match at the right depth", () => {
    const text = "(a (b (c) d) e)"
    expect(showParenCompute(text, 3)).toEqual({ hereBeg: 3, hereEnd: 4, thereBeg: 11, thereEnd: 12, mismatch: false })
    expect(showParenCompute(text, 12)).toEqual({ hereBeg: 11, hereEnd: 12, thereBeg: 3, thereEnd: 4, mismatch: false })
    expect(showParenCompute(text, 6)).toEqual({ hereBeg: 6, hereEnd: 7, thereBeg: 8, thereEnd: 9, mismatch: false })
  })

  test("mixed bracket kinds nest by depth", () => {
    const text = "{ a [ b ( c ) d ] e }"
    expect(showParenCompute(text, 0)?.thereBeg).toBe(20)
    expect(showParenCompute(text, 4)?.thereBeg).toBe(16)
    expect(showParenCompute(text, 8)?.thereBeg).toBe(12)
  })

  test("close-before-point wins over open-at-point", () => {
    const text = "(a)(b)"
    const data = showParenCompute(text, 3)
    expect(data).not.toBeNull()
    expect(data!.hereBeg).toBe(2)
    expect(data!.thereBeg).toBe(0)
  })

  test("returns null when point is not at a paren", () => {
    expect(showParenCompute("(foo)", 2)).toBeNull()
    expect(showParenCompute("hello", 0)).toBeNull()
    expect(showParenCompute("", 0)).toBeNull()
  })

  test("unbalanced opener reports mismatch with no there-range", () => {
    const data = showParenCompute("(foo", 0)
    expect(data).toEqual({ hereBeg: 0, hereEnd: 1, thereBeg: null, thereEnd: null, mismatch: true })
  })

  test("unbalanced closer reports mismatch with no there-range", () => {
    const data = showParenCompute("foo)", 4)
    expect(data).toEqual({ hereBeg: 3, hereEnd: 4, thereBeg: null, thereEnd: null, mismatch: true })
  })

  test("wrong bracket kind is a mismatch", () => {
    const data = showParenCompute("(foo]", 0)
    expect(data).not.toBeNull()
    expect(data!.thereBeg).toBe(4)
    expect(data!.mismatch).toBe(true)
  })

  test("whenPointInsideParen finds paren just behind point", () => {
    const text = "(foo)"
    expect(showParenCompute(text, 1)).toBeNull()
    const data = showParenCompute(text, 1, { whenPointInsideParen: true })
    expect(data).toEqual({ hereBeg: 0, hereEnd: 1, thereBeg: 4, thereEnd: 5, mismatch: false })
  })

  test("whenPointInsideParen finds closer just at point", () => {
    const text = "(foo)"
    const data = showParenCompute(text, 4, { whenPointInsideParen: true })
    expect(data).toEqual({ hereBeg: 4, hereEnd: 5, thereBeg: 0, thereEnd: 1, mismatch: false })
  })
})

describe("show-paren-mode", () => {
  test("toggle command enables and disables the global minor mode", async () => {
    const editor = makeEditor()
    install(editor)
    expect(editor.isMinorModeEnabled("show-paren-mode")).toBe(false)
    await editor.run("show-paren-mode")
    expect(editor.isMinorModeEnabled("show-paren-mode")).toBe(true)
    await editor.run("show-paren-mode")
    expect(editor.isMinorModeEnabled("show-paren-mode")).toBe(false)
  })

  test("stores match data in buffer.locals after point moves", async () => {
    const editor = makeEditor()
    install(editor)
    await editor.run("show-paren-mode")
    const buf = editor.scratch("*paren*", "(foo (bar) baz)", "text")
    buf.point = 0
    await editor.changed("test")
    const data = showParenData(buf)
    expect(data).not.toBeNull()
    expect(data!.hereBeg).toBe(0)
    expect(data!.thereBeg).toBe(14)
    expect(data!.mismatch).toBe(false)
  })

  test("clears locals when point leaves a paren", async () => {
    const editor = makeEditor()
    install(editor)
    await editor.run("show-paren-mode")
    const buf = editor.scratch("*paren*", "(foo)", "text")
    buf.point = 0
    await editor.changed("test")
    expect(buf.locals.get(SHOW_PAREN_LOCAL)).toBeDefined()
    buf.point = 2
    await editor.changed("test")
    expect(buf.locals.get(SHOW_PAREN_LOCAL)).toBeUndefined()
  })

  test("disabling the mode clears locals from all buffers", async () => {
    const editor = makeEditor()
    install(editor)
    await editor.run("show-paren-mode")
    const buf = editor.scratch("*paren*", "()", "text")
    buf.point = 0
    await editor.changed("test")
    expect(showParenData(buf)).not.toBeNull()
    await editor.run("show-paren-mode")
    expect(showParenData(buf)).toBeNull()
  })

  test("respects show-paren-when-point-inside-paren defcustom", async () => {
    const editor = makeEditor()
    install(editor)
    await editor.run("show-paren-mode")
    const buf = editor.scratch("*paren*", "(foo)", "text")
    buf.point = 1
    await editor.changed("test")
    expect(showParenData(buf)).toBeNull()
    setCustom("show-paren-when-point-inside-paren", true)
    await editor.changed("test")
    expect(showParenData(buf)?.thereBeg).toBe(4)
    setCustom("show-paren-when-point-inside-paren", false)
  })
})

describe("showParenSpans", () => {
  test("renders match and mismatch faces as overlay spans", async () => {
    const editor = makeEditor()
    install(editor)
    editor.enableMinorMode("show-paren-mode")
    const buf = editor.scratch("t.ts", "(ok)", "text")
    buf.point = buf.text.length
    await editor.changed("test")
    expect(showParenSpans(buf)).toEqual([
      { start: 3, end: 4, face: "show-paren-match" },
      { start: 0, end: 1, face: "show-paren-match" },
    ])

    buf.setText("(bad]")
    buf.point = buf.text.length
    await editor.changed("test")
    expect(showParenSpans(buf).every(s => s.face === "show-paren-mismatch")).toBe(true)
  })
})
