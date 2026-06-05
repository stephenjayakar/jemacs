import { describe, expect, test, beforeEach } from "bun:test"
import { makeEditor } from "./helper"
import { install, indentLine, completeAtPoint, forwardSexp } from "../../plugins/sexp"
import {
  defgeneric,
  defmethod,
  getGeneric,
  callGeneric,
  methodFor,
  removeMethod,
  clearGenerics,
  listGenerics,
  GENERIC_DEFAULT_MODE,
} from "../../src/runtime/generic"
import { defineMode } from "../../src/modes/mode"
import type { BufferModel } from "../../src/kernel/buffer"

describe("defgeneric / defmethod", () => {
  beforeEach(() => clearGenerics("test-gen"))

  test("dispatch picks the most specific mode in the lineage", () => {
    const editor = makeEditor()
    defineMode({ name: "ts-base", parent: "prog-mode" })
    defineMode({ name: "ts-child", parent: "ts-base" })
    const buf = editor.scratch("*g*", "", "ts-child")

    const g = defgeneric<(b: BufferModel) => string>("test-gen")
    defmethod("test-gen", "prog-mode", () => "prog")
    expect(g(buf)).toBe("prog")

    defmethod("test-gen", "ts-base", () => "base")
    expect(g(buf)).toBe("base")

    defmethod("test-gen", "ts-child", () => "child")
    expect(g(buf)).toBe("child")
    expect(g.methodFor("ts-base")?.(buf)).toBe("base")
  })

  test('"t" is the catch-all when no lineage method matches', () => {
    const editor = makeEditor()
    const buf = editor.scratch("*g*", "", "text")
    const g = defgeneric<(b: BufferModel) => string>("test-gen", { fallback: () => "fallback" })
    expect(g(buf)).toBe("fallback")
    defmethod("test-gen", GENERIC_DEFAULT_MODE, () => "default")
    expect(g(buf)).toBe("default")
    expect(methodFor("test-gen", "text")).toBeDefined()
  })

  test("defmethod before defgeneric works (load-order independent)", () => {
    const editor = makeEditor()
    const buf = editor.scratch("*g*", "", "text")
    defmethod("test-gen", "text", () => "early")
    const g = defgeneric<(b: BufferModel) => string>("test-gen")
    expect(g(buf)).toBe("early")
    expect(getGeneric("test-gen")).toBe(g)
  })

  test("defgeneric is idempotent across re-import", () => {
    const a = defgeneric("test-gen")
    defmethod("test-gen", "text", () => "kept")
    const b = defgeneric("test-gen")
    expect(b).toBe(a)
    expect(b.methods().has("text")).toBe(true)
    expect(listGenerics()).toContain("test-gen")

    // redeclare updates fallback when provided, preserves it when omitted
    const editor = makeEditor()
    const buf = editor.scratch("*g*", "", "text")
    removeMethod("test-gen", "text")
    defgeneric("test-gen", { fallback: () => 1 })
    expect(a(buf)).toBe(1)
    defgeneric("test-gen", { fallback: () => 2 })
    expect(a(buf)).toBe(2)
    defgeneric("test-gen", {})
    expect(a(buf)).toBe(2)
  })

  test("callGeneric and removeMethod", () => {
    const editor = makeEditor()
    const buf = editor.scratch("*g*", "", "text")
    defgeneric("test-gen")
    defmethod("test-gen", "text", () => 42)
    expect(callGeneric<number>("test-gen", buf)).toBe(42)
    expect(removeMethod("test-gen", "text")).toBe(true)
    expect(callGeneric("test-gen", buf)).toBeUndefined()
    expect(callGeneric("never-declared", buf)).toBeUndefined()
  })
})

describe("Mode field bridge (indent-line / complete-at-point)", () => {
  test("indent-line generic delegates to legacy Mode.indentLine", () => {
    const editor = makeEditor()
    install(editor)
    const buf = editor.scratch("*js*", "function f() {\nreturn 1\n}\n", "javascript")
    buf.point = "function f() {\n".length
    indentLine(buf)
    expect(buf.text.split("\n")[1]).toBe("  return 1")
  })

  test("indent-line falls back to two-space insert for modes without indentLine", () => {
    const editor = makeEditor()
    install(editor)
    const buf = editor.scratch("*txt*", "abc", "text")
    buf.point = 0
    indentLine(buf)
    expect(buf.text).toBe("  abc")
  })

  test("complete-at-point generic delegates to legacy Mode.completeAtPoint", () => {
    const editor = makeEditor()
    install(editor)
    const buf = editor.scratch("*js*", "func", "javascript")
    buf.point = 4
    const cands = completeAtPoint(buf)
    expect(cands.map(c => c.text)).toContain("function")
  })

  test("a defmethod overrides the legacy Mode field for that mode", () => {
    const editor = makeEditor()
    install(editor)
    try {
      defmethod("complete-at-point", "javascript", () => [{ text: "OVERRIDE", start: 0, end: 0 }])
      const buf = editor.scratch("*js*", "x", "javascript")
      buf.point = 1
      expect(completeAtPoint(buf).map(c => c.text)).toEqual(["OVERRIDE"])
    } finally {
      removeMethod("complete-at-point", "javascript")
    }
  })
})

describe("forward-sexp", () => {
  function setup(text: string, point: number, mode = "text") {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*sexp*", text, mode)
    buffer.point = point
    return { editor, buffer }
  }

  test("moves over a balanced group", async () => {
    const { editor, buffer } = setup("(foo (bar) baz) tail", 0)
    await editor.run("forward-sexp")
    expect(buffer.point).toBe(15)
  })

  test("moves over an atom when not at a delimiter", async () => {
    const { editor, buffer } = setup("foo bar", 0)
    await editor.run("forward-sexp")
    expect(buffer.point).toBe(3)
  })

  test("backward-sexp from after a closer lands before its opener", async () => {
    const { editor, buffer } = setup("a (b c) d", 7)
    await editor.run("backward-sexp")
    expect(buffer.point).toBe(2)
  })

  test("reports failure at an unmatched closer without moving", async () => {
    const { editor, buffer } = setup(") trailing", 0)
    let msg = ""
    editor.events.on("message", ({ text }) => { msg = text })
    await editor.run("forward-sexp")
    expect(buffer.point).toBe(0)
    expect(msg).toContain("No next sexp")
  })

  test("prefix argument repeats", async () => {
    const { buffer } = setup("(a) (b) (c)", 0)
    expect(forwardSexp(buffer, 2)).toBe(true)
    expect(buffer.point).toBe(7)
  })

  test("C-M-f / C-M-b are bound", () => {
    const editor = makeEditor()
    install(editor)
    expect(editor.keymaps.lookup("C-M-f")).toMatchObject({ status: "matched", command: "forward-sexp" })
    expect(editor.keymaps.lookup("C-M-b")).toMatchObject({ status: "matched", command: "backward-sexp" })
  })

  test("per-mode method overrides the default scanner", () => {
    const { buffer } = setup("xxxx", 0, "rust")
    try {
      defmethod("forward-sexp", "rust", (b, _n) => { b.point = b.text.length; return true })
      expect(forwardSexp(buffer, 1)).toBe(true)
      expect(buffer.point).toBe(4)
    } finally {
      removeMethod("forward-sexp", "rust")
    }
  })
})
