import { expect, test } from "bun:test"
import { BufferModel } from "../../src/kernel/buffer"
import { emacsLispIndentLine, installEmacsLispMode } from "../../src/modes/emacs-lisp"
import { getMode, modeFeature, type TextSpan } from "../../src/modes/mode"
import { installLispModes, lispFontLock, lispImenuIndex, schemeFontLock, schemeImenuIndex } from "../../src/modes/lisp"

function expectSpan(text: string, spans: TextSpan[], needle: string, face: TextSpan["face"]): void {
  const start = text.indexOf(needle)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(spans).toContainEqual({ start, end: start + needle.length, face })
}

test("lisp modes register GNU mode names and reuse sexp indentation", () => {
  installEmacsLispMode()
  installLispModes()

  expect(getMode("lisp-mode")?.parent).toBe("prog-mode")
  expect(getMode("lisp-mode")?.commentStart).toBe(";")
  expect(getMode("lisp-interaction-mode")?.parent).toBe("emacs-lisp-mode")
  expect(getMode("scheme-mode")?.parent).toBe("prog-mode")
  expect(getMode("scheme-mode")?.commentStart).toBe(";")
  expect(modeFeature("lisp-mode", "indentLine")).toBe(emacsLispIndentLine)
  expect(modeFeature("scheme-mode", "indentLine")).toBe(emacsLispIndentLine)
  expect(modeFeature("lisp-interaction-mode", "fontLock")).toBeDefined()
})

test("lisp-mode font-lock highlights comments, strings, definitions, keywords, and quoted symbols", () => {
  installLispModes()
  const text = [
    "; top comment",
    "(defun greet (name)",
    "  #| block",
    "     comment |#",
    "  (let* ((message \"hello\"))",
    "    (when name",
    "      (list :target 'name #'print message))))",
    "(defclass widget () ())",
    "(defparameter *count* 3)",
  ].join("\n")
  const buffer = new BufferModel({ name: "sample.lisp", text, mode: "lisp-mode" })
  const spans = lispFontLock(buffer)

  expectSpan(text, spans, "; top comment", "comment")
  expectSpan(text, spans, "#| block\n     comment |#", "comment")
  expectSpan(text, spans, "\"hello\"", "string")
  expectSpan(text, spans, "defun", "keyword")
  expectSpan(text, spans, "greet", "function")
  expectSpan(text, spans, "let*", "keyword")
  expectSpan(text, spans, "when", "keyword")
  expectSpan(text, spans, ":target", "constant")
  expectSpan(text, spans, "'name", "constant")
  expectSpan(text, spans, "#'print", "constant")
  expectSpan(text, spans, "widget", "type")
  expectSpan(text, spans, "*count*", "constant")
  expectSpan(text, spans, "3", "number")

  const ranged = lispFontLock(buffer, { startLine: 1, endLine: 5, start: buffer.lineStarts[1]!, end: buffer.lineStarts[5]! })
  expect(ranged.some(span => text.slice(span.start, span.end) === "; top comment")).toBe(false)
  expectSpan(text, ranged, "defun", "keyword")
  expectSpan(text, ranged, "#| block\n     comment |#", "comment")
})

test("scheme-mode font-lock highlights comments, strings, definitions, keywords, and quoted symbols", () => {
  installLispModes()
  const text = [
    "; scheme comment",
    "(define (square x)",
    "  (if (and x (> x 0))",
    "      (begin \"positive\")",
    "      'zero))",
    "(define-syntax when-positive body)",
    "(define-record-type point)",
    "#| block comment |#",
  ].join("\n")
  const buffer = new BufferModel({ name: "sample.scm", text, mode: "scheme-mode" })
  const spans = schemeFontLock(buffer)

  expectSpan(text, spans, "; scheme comment", "comment")
  expectSpan(text, spans, "#| block comment |#", "comment")
  expectSpan(text, spans, "\"positive\"", "string")
  expectSpan(text, spans, "define", "keyword")
  expectSpan(text, spans, "square", "function")
  expectSpan(text, spans, "if", "keyword")
  expectSpan(text, spans, "and", "keyword")
  expectSpan(text, spans, "begin", "keyword")
  expectSpan(text, spans, "'zero", "constant")
  expectSpan(text, spans, "when-positive", "function")
  expectSpan(text, spans, "point", "type")
})

test("lisp-family modes use sexp indentation", () => {
  installLispModes()
  const lisp = new BufferModel({ name: "sample.lisp", text: "(defun greet (name)\n(message name)\n  )\n", mode: "lisp-mode" })
  const lispIndentLine = modeFeature("lisp-mode", "indentLine")!

  lisp.point = lisp.text.indexOf("message")
  lispIndentLine(lisp)
  expect(lisp.text).toContain("(defun greet (name)\n  (message name)")

  lisp.point = lisp.text.lastIndexOf(")")
  lispIndentLine(lisp)
  expect(lisp.text.endsWith("\n)\n")).toBe(true)

  const scheme = new BufferModel({ name: "sample.scm", text: "(let ((x 1))\n(if x\nx\n0))\n", mode: "scheme-mode" })
  const schemeIndentLine = modeFeature("scheme-mode", "indentLine")!

  scheme.point = scheme.text.indexOf("if")
  schemeIndentLine(scheme)
  expect(scheme.text).toContain("(let ((x 1))\n  (if x")

  scheme.point = scheme.text.indexOf("x\n0")
  schemeIndentLine(scheme)
  expect(scheme.text).toContain("  (if x\n    x")
})

test("lisp-family modes index and move across top-level definitions", () => {
  installLispModes()
  const lispText = "(defun first ()\n  1)\n\n(defclass second () ())\n"
  const lisp = new BufferModel({ name: "sample.lisp", text: lispText, mode: "lisp-mode" })
  expect(lispImenuIndex(lisp)).toEqual([
    { name: "first", point: 0 },
    { name: "second", point: lispText.indexOf("(defclass") },
  ])

  modeFeature("lisp-mode", "endOfDefun")!(lisp)
  expect(lisp.point).toBe(lispText.indexOf(")\n\n") + 1)

  lisp.point = lispText.length
  modeFeature("lisp-mode", "beginningOfDefun")!(lisp)
  expect(lisp.point).toBe(lispText.indexOf("(defclass"))

  const schemeText = "(define (first) 1)\n\n(define-record-type second)\n"
  const scheme = new BufferModel({ name: "sample.scm", text: schemeText, mode: "scheme-mode" })
  expect(schemeImenuIndex(scheme)).toEqual([
    { name: "first", point: 0 },
    { name: "second", point: schemeText.indexOf("(define-record-type") },
  ])

  scheme.point = schemeText.length
  modeFeature("scheme-mode", "beginningOfDefun")!(scheme)
  expect(scheme.point).toBe(schemeText.indexOf("(define-record-type"))
})
