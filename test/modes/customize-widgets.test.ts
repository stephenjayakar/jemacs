/**
 * Parity tests for the Custom buffer's value widgets.
 *
 * Every expected buffer below was captured from GNU Emacs 30.2 running
 * `emacs -Q --batch` with the same `defcustom`s, so the assertions are the
 * literal cus-edit.el / wid-edit.el output. The only intentional difference is
 * the button row: `emacs -Q` cannot save, so it prints `[ Revert... ] [ Apply ] `
 * where a savable session (and jemacs) prints `[ Apply and Save ]` too.
 */
import { expect, test } from "bun:test"
import { makeEditor } from "../plugins/helper"
import type { Editor } from "../../src/kernel/editor"
import { defcustom, defgroup, getCustom, resetCustom, setCustom } from "../../src/runtime/custom"
import { defface, getCustomFace, resetFace } from "../../src/runtime/faces"

/** The header every Custom buffer starts with. */
const HEADER = [
  "For help using this buffer, see [Easy Customization] in the [Emacs manual].",
  "",
  "                                         [ Search ]",
  "",
  "Operate on all settings in this buffer:",
  "[ Revert... ] [ Apply ] [ Apply and Save ]",
  "",
]

function body(editor: Editor): string[] {
  const lines = editor.currentBuffer.text.split("\n")
  expect(lines.slice(0, HEADER.length)).toEqual(HEADER)
  return lines.slice(HEADER.length)
}

test("scalar widgets print the Emacs type tag and value", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defcustom("w-integer", "integer", 8, "Integer doc.", "editing")
  defcustom("w-natnum", "natnum", 3, "Natnum doc.", "editing")
  defcustom("w-number", "number", 1.5, "Number doc.", "editing")
  defcustom("w-string", "string", "hi", "String doc.", "editing")
  defcustom("w-regexp", "regexp", "^a", "Regexp doc.", "editing")
  defcustom("w-file", "file", "/tmp/x", "File doc.", "editing")
  defcustom("w-directory", "directory", "/tmp", "Directory doc.", "editing")
  defcustom("w-symbol", "symbol", "foo", "Symbol doc.", "editing")
  defcustom("w-function", "function", "ignore", "Function doc.", "editing")
  defcustom("w-boolean", "boolean", false, "Boolean doc.", "editing")

  // Captured from Emacs: `Hide W Integer: Integer: 8` etc.
  const expected: Array<[string, string]> = [
    ["w-integer", "Hide W Integer: Integer: 8"],
    ["w-natnum", "Hide W Natnum: Integer (positive or zero): 3"],
    ["w-number", "Hide W Number: Number: 1.5"],
    ["w-string", "Hide W String: String: hi"],
    ["w-regexp", "Hide W Regexp: Regexp: ^a"],
    ["w-file", "Hide W File: File: /tmp/x"],
    ["w-directory", "Hide W Directory: Directory: /tmp"],
    ["w-symbol", "Hide W Symbol: Symbol: foo"],
    ["w-function", "Hide W Function: Function: ignore"],
    ["w-boolean", "Hide W Boolean: Boolean: [Toggle]  off (nil)"],
  ]
  for (const [name, heading] of expected) {
    await editor.run("customize-variable", [name])
    expect(body(editor)[0], name).toBe(heading)
    expect(body(editor)[1], name).toBe("   [ State ]: STANDARD.")
  }
})

test("the face widget prints [link] (sample) NAME, and sexp prints Lisp expression", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defcustom("w-face", "face", "default", "Face doc.", "editing")
  defcustom("w-sexp", "sexp", { a: 1 }, "Sexp doc.", "editing")

  await editor.run("customize-variable", ["w-face"])
  expect(body(editor)[0]).toBe("Hide W Face: Face: [link] (sample) default")
  await editor.run("customize-variable", ["w-sexp"])
  expect(body(editor)[0]).toBe("Hide W Sexp: Lisp expression: {\"a\":1}")
})

test("the repeat widget prints [INS] [DEL] rows exactly as Emacs does", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defcustom("w-repeat", { kind: "repeat", item: "string" }, ["a", "b"], "Repeat doc.", "editing")

  await editor.run("customize-variable", ["w-repeat"])
  expect(body(editor)).toEqual([
    "Hide W Repeat:",
    "Repeat:",
    "[INS] [DEL] String: a",
    "[INS] [DEL] String: b",
    "[INS]",
    "   [ State ]: STANDARD.",
    "   Repeat doc.",
    "Groups: [Editing]",
    "",
  ])
})

test("the alist widget prints the value indented under its key", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defcustom("w-alist", { kind: "alist", key: "symbol", value: "string" },
    [["a", "x"]], "Alist doc.", "editing")

  await editor.run("customize-variable", ["w-alist"])
  expect(body(editor)).toEqual([
    "Hide W Alist:",
    "Alist:",
    "[INS] [DEL] Symbol: a",
    "            String: x",
    "[INS]",
    "   [ State ]: STANDARD.",
    "   Alist doc.",
    "Groups: [Editing]",
    "",
  ])
})

test("the hook and set widgets match Emacs", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defcustom("w-hook", { kind: "hook" }, [], "Hook doc.", "editing")
  defcustom("w-set", { kind: "set", options: [{ const: "x" }, { const: "y" }] }, ["x"], "Set doc.", "editing")

  await editor.run("customize-variable", ["w-hook"])
  expect(body(editor).slice(0, 3)).toEqual(["Hide W Hook:", "Hook:", "[INS]"])
  await editor.run("customize-variable", ["w-set"])
  expect(body(editor).slice(0, 4)).toEqual(["Hide W Set:", "Set:", "[X] x", "[ ] y"])
})

test("the choice widget prints [Value Menu] and the menu switches arms", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defcustom("w-choice", {
    kind: "choice",
    options: [{ const: "alpha" }, { const: "beta" }, { const: "gamma", tag: "Gamma ray" }],
  }, "alpha", "Choice doc.", "editing")

  await editor.run("customize-variable", ["w-choice"])
  expect(body(editor)[0]).toBe("Hide W Choice: Choice: [Value Menu] alpha")

  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("[Value Menu]")
  const menu = editor.run("Custom-newline")
  // `(const :tag "Gamma ray" gamma)` is offered under its tag, as in Emacs.
  expect(editor.minibuffer?.collection).toEqual(["alpha", "beta", "Gamma ray"])
  editor.activeBuffer.setText("Gamma ray", true)
  editor.minibufferSubmit()
  await menu
  expect(body(editor)[0]).toBe("Hide W Choice: Choice: [Value Menu] Gamma ray")
  expect(body(editor)[1]).toBe("   [ State ]: EDITED, shown value does not take effect until you set or save it.")

  await editor.run("Custom-set")
  expect(getCustom<string>("w-choice")).toBe("gamma")
  resetCustom("w-choice")
})

test("[INS] and [DEL] add and remove repeat elements, and Apply installs them", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defcustom("w-edit-repeat", { kind: "repeat", item: "string" }, ["a"], "Doc.", "editing")

  await editor.run("customize-variable", ["w-edit-repeat"])
  // Trailing [INS] appends; the new element gets an empty editable field.
  editor.currentBuffer.point = editor.currentBuffer.text.lastIndexOf("[INS]")
  await editor.run("Custom-newline")
  expect(body(editor).slice(0, 5)).toEqual([
    "Hide W Edit Repeat:",
    "Repeat:",
    "[INS] [DEL] String: a",
    "[INS] [DEL] String: ",
    "[INS]",
  ])

  const buffer = editor.currentBuffer
  buffer.point = buffer.text.indexOf("String: \n") + "String: ".length
  buffer.insert("zed")
  await editor.run("Custom-set")
  expect(getCustom<string[]>("w-edit-repeat")).toEqual(["a", "zed"])

  // [DEL] removes the row it sits on.
  await editor.run("customize-variable", ["w-edit-repeat"])
  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("[DEL]")
  await editor.run("Custom-newline")
  await editor.run("Custom-set")
  expect(getCustom<string[]>("w-edit-repeat")).toEqual(["zed"])
  resetCustom("w-edit-repeat")
})

test("a set checkbox toggles membership", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defcustom("w-edit-set", { kind: "set", options: [{ const: "x" }, { const: "y" }] },
    ["x"], "Doc.", "editing")

  await editor.run("customize-variable", ["w-edit-set"])
  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("[ ] y")
  await editor.run("Custom-newline")
  expect(body(editor).slice(1, 4)).toEqual(["Set:", "[X] x", "[X] y"])
  await editor.run("Custom-set")
  expect(getCustom<string[]>("w-edit-set")).toEqual(["x", "y"])
  resetCustom("w-edit-set")
})

test("integer and natnum fields reject values Emacs would reject", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defcustom("w-valid-int", "integer", 1, "Doc.", "editing")
  defcustom("w-valid-nat", "natnum", 1, "Doc.", "editing")

  await expect(editor.run("customize-set-variable", ["w-valid-int", "1.5"]))
    .rejects.toThrow(/Invalid integer: 1\.5/)
  await expect(editor.run("customize-set-variable", ["w-valid-nat", "-2"]))
    .rejects.toThrow(/Invalid integer \(positive or zero\): -2/)
  await editor.run("customize-set-variable", ["w-valid-int", "-2"])
  expect(getCustom<number>("w-valid-int")).toBe(-2)
  resetCustom("w-valid-int")
})

test("Show Saved Lisp Expression switches the widget to a sexp field", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defcustom("w-form", "integer", 7, "Doc.", "editing")

  await editor.run("customize-variable", ["w-form"])
  expect(body(editor)[0]).toBe("Hide W Form: Integer: 7")
  await editor.run("custom-variable-edit-lisp")
  expect(body(editor)[0]).toBe("Hide W Form: Lisp expression: 7")
  await editor.run("custom-variable-edit")
  expect(body(editor)[0]).toBe("Hide W Form: Integer: 7")
})

test("custom-comment-show adds the Comment field, and Apply stores it", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defcustom("w-noted", "integer", 1, "Doc.", "editing")

  await editor.run("customize-variable", ["w-noted"])
  expect(editor.currentBuffer.text).not.toContain("Comment:")
  await editor.run("custom-comment-show")
  expect(editor.currentBuffer.text).toContain("Comment: ")

  const buffer = editor.currentBuffer
  buffer.point = buffer.text.indexOf("Comment: ") + "Comment: ".length
  buffer.insert("a note")
  await editor.run("Custom-set")
  expect(body(editor).map(l => l.trimEnd())).toContain("Comment: a note")
  // cus-edit.el keeps the comment with the setting, so it is a customization.
  expect(body(editor)[1]).toBe("   [ State ]: SET for current session only.")
  resetCustom("w-noted")
})

test("a face attribute checkbox unchecks the attribute and Apply drops it", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defface("w-attr-face", { fg: "#ff0000", bold: true }, "Doc.", "editing")

  await editor.run("customize-face", ["w-attr-face"])
  expect(editor.currentBuffer.text).toContain("   [X] Weight: [Value Menu] bold")
  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("[X] Weight")
  await editor.run("Custom-newline")
  expect(editor.currentBuffer.text).toContain("   [ ] Weight: [Value Menu] bold")
  await editor.run("Custom-set")
  expect(editor.currentBuffer.text).not.toContain("[X] Weight")
  resetFace("w-attr-face")
})

test("a face [Value Menu] offers cus-face.el's own arms", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defface("w-menu-face", { weight: "normal" }, "Doc.", "editing")

  await editor.run("customize-face", ["w-menu-face"])
  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("[Value Menu]")
  const menu = editor.run("Custom-newline")
  // cus-face.el's `:weight` arm list, in its order.
  expect(editor.minibuffer?.collection).toEqual([
    "thin", "ultralight", "ultra-light", "extralight", "extra-light", "light",
    "semilight", "semi-light", "demilight", "normal", "regular", "book",
    "medium", "semibold", "semi-bold", "demibold", "demi-bold", "bold",
    "extrabold", "extra-bold", "ultrabold", "ultra-bold", "heavy", "black",
    "ultra-heavy", "ultraheavy",
  ])
  editor.activeBuffer.setText("bold", true)
  editor.minibufferSubmit()
  await menu
  expect(editor.currentBuffer.text).toContain("   [X] Weight: [Value Menu] bold")
  await editor.run("Custom-set")
  expect(getCustomFace("w-menu-face")?.spec.weight).toBe("bold")
  // The display layer's boolean tracks the finer-grained value.
  expect(getCustomFace("w-menu-face")?.spec.bold).toBe(true)
  resetFace("w-menu-face")
})

test("customize-changed lists the settings that are no longer standard", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defcustom("w-changed-a", "integer", 1, "Doc A.", "editing")
  setCustom("w-changed-a", 3)

  await editor.run("customize-changed", ["30.1"])
  expect(editor.currentBuffer.name).toBe("*Customize Changed Options*")
  expect(editor.currentBuffer.text).toContain("W Changed A")
  resetCustom("w-changed-a")
})
