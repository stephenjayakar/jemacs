import type { BufferModel } from "../kernel/buffer"
import { Keymap } from "../kernel/keymap"
import { emacsLispIndentLine } from "./emacs-lisp"
import { defineMode, type FontLockRange, type ImenuIndexEntry, type TextSpan } from "./mode"

const commonLispKeywords = new Set([
  "cond", "defclass", "defmacro", "defmethod", "defparameter", "defun", "defvar", "dolist", "dotimes", "if", "lambda", "let", "let*", "loop", "unless", "when",
])

const schemeKeywords = new Set([
  "and", "begin", "case", "cond", "define", "define-record-type", "define-syntax", "do", "else", "if", "lambda", "let", "let*", "letrec", "or", "quasiquote", "quote", "set!", "unless", "when",
])

const lispDefunRegex = /^[ \t]*\((?:defun|defmacro|defvar|defparameter|defclass|defmethod)\s+([^\s()]+)/gim
const schemeDefunRegex = /^[ \t]*\((?:define(?:-syntax|-record-type)?)(?:\s+\(([^\s()]+)|\s+([^\s()]+))/gm
const lispFunctionDefinitionRegex = /\((?:defun|defmacro|defmethod)\s+([^\s()]+)/gi
const lispConstantDefinitionRegex = /\((?:defvar|defparameter)\s+([^\s()]+)/gi
const lispTypeDefinitionRegex = /\(defclass\s+([^\s()]+)/gi
const schemeFunctionDefinitionRegex = /\(define\s+(?:\(([^\s()]+)|([^\s()]+))/g
const schemeSyntaxDefinitionRegex = /\(define-syntax\s+([^\s()]+)/g
const schemeRecordDefinitionRegex = /\(define-record-type\s+([^\s()]+)/g
const lispNumberRegex = /(?<![^\s()])[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?(?![^\s()])/g
const lispTokenRegex = /[^\s()"';]+/g
const lispKeywordSymbolRegex = /(^|[\s(])(:[^\s()"';]+)/g
const lispQuotedSymbolRegex = /(^|[\s(])('(?:[^\s()"';]+))/g
const lispFunctionQuotedSymbolRegex = /(^|[\s(])(#'(?:[^\s()"';]+))/g

export function installLispModes(): void {
  const lispKeymap = new Keymap("lisp-mode-map")
  lispKeymap.bind("C-M-a", "beginning-of-defun")
  lispKeymap.bind("C-M-e", "end-of-defun")

  const schemeKeymap = new Keymap("scheme-mode-map")
  schemeKeymap.bind("C-M-a", "beginning-of-defun")
  schemeKeymap.bind("C-M-e", "end-of-defun")

  defineMode({
    name: "lisp-mode",
    parent: "prog-mode",
    commentStart: ";",
    keymap: lispKeymap,
    indentLine: emacsLispIndentLine,
    fontLock: lispFontLock,
    beginningOfDefun: lispBeginningOfDefun,
    endOfDefun: lispEndOfDefun,
    imenuIndex: lispImenuIndex,
  })

  defineMode({ name: "lisp-interaction-mode", parent: "emacs-lisp-mode" })

  defineMode({
    name: "scheme-mode",
    parent: "prog-mode",
    commentStart: ";",
    keymap: schemeKeymap,
    indentLine: emacsLispIndentLine,
    fontLock: schemeFontLock,
    beginningOfDefun: schemeBeginningOfDefun,
    endOfDefun: schemeEndOfDefun,
    imenuIndex: schemeImenuIndex,
  })
}

export function lispFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const spans: TextSpan[] = []
  const { text, offset } = fontLockSlice(buffer, range)
  spans.push(...lispProtectedSpans(text, offset))

  addGroupedMatches(text, lispFunctionDefinitionRegex, "function", spans, offset, 1, true)
  addGroupedMatches(text, lispConstantDefinitionRegex, "constant", spans, offset, 1, true)
  addGroupedMatches(text, lispTypeDefinitionRegex, "type", spans, offset, 1, true)
  addMatches(text, lispNumberRegex, "number", spans, offset, true)
  addGroupedMatches(text, lispKeywordSymbolRegex, "constant", spans, offset, 2, true)
  addGroupedMatches(text, lispFunctionQuotedSymbolRegex, "constant", spans, offset, 2, true)
  addGroupedMatches(text, lispQuotedSymbolRegex, "constant", spans, offset, 2, true)
  addMatches(text, lispTokenRegex, "keyword", spans, offset, true, word => commonLispKeywords.has(word.toLowerCase()))

  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

export function schemeFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const spans: TextSpan[] = []
  const { text, offset } = fontLockSlice(buffer, range)
  spans.push(...lispProtectedSpans(text, offset))

  addGroupedDefinitionMatch(text, schemeFunctionDefinitionRegex, "function", spans, offset)
  addGroupedMatches(text, schemeSyntaxDefinitionRegex, "function", spans, offset, 1, true)
  addGroupedMatches(text, schemeRecordDefinitionRegex, "type", spans, offset, 1, true)
  addMatches(text, lispNumberRegex, "number", spans, offset, true)
  addGroupedMatches(text, lispQuotedSymbolRegex, "constant", spans, offset, 2, true)
  addMatches(text, lispTokenRegex, "keyword", spans, offset, true, word => schemeKeywords.has(word.toLowerCase()))

  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

export function lispImenuIndex(buffer: BufferModel): ImenuIndexEntry[] {
  return imenuIndex(buffer, lispDefunRegex)
}

export function schemeImenuIndex(buffer: BufferModel): ImenuIndexEntry[] {
  return imenuIndex(buffer, schemeDefunRegex)
}

export function lispBeginningOfDefun(buffer: BufferModel): void {
  beginningOfDefun(buffer, lispDefunRegex)
}

export function lispEndOfDefun(buffer: BufferModel): void {
  endOfDefun(buffer, lispDefunRegex)
}

export function schemeBeginningOfDefun(buffer: BufferModel): void {
  beginningOfDefun(buffer, schemeDefunRegex)
}

export function schemeEndOfDefun(buffer: BufferModel): void {
  endOfDefun(buffer, schemeDefunRegex)
}

function imenuIndex(buffer: BufferModel, regex: RegExp): ImenuIndexEntry[] {
  const entries: ImenuIndexEntry[] = []
  for (const match of buffer.text.matchAll(regex)) {
    entries.push({ name: match[1] ?? match[2] ?? match[0], point: match.index ?? 0 })
  }
  return entries
}

function beginningOfDefun(buffer: BufferModel, regex: RegExp): void {
  let target = 0
  for (const match of buffer.text.matchAll(regex)) {
    if (match.index == null || match.index >= buffer.point) break
    target = match.index
  }
  buffer.point = target
}

function endOfDefun(buffer: BufferModel, regex: RegExp): void {
  const start = findCurrentDefunStart(buffer, regex)
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < buffer.text.length;) {
    const ch = buffer.text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === "\"") inString = false
      i++
      continue
    }
    if (buffer.text.startsWith("#|", i)) {
      i = blockCommentEnd(buffer.text, i)
      continue
    }
    if (ch === ";") {
      i = lineEnd(buffer.text, i)
      continue
    }
    if (ch === "\"") inString = true
    else if (ch === "(") depth++
    else if (ch === ")") {
      depth--
      if (depth <= 0) {
        buffer.point = i + 1
        return
      }
    }
    i++
  }
  buffer.point = buffer.text.length
}

function findCurrentDefunStart(buffer: BufferModel, regex: RegExp): number {
  let target = 0
  for (const match of buffer.text.matchAll(regex)) {
    if (match.index == null || match.index > buffer.point) break
    target = match.index
  }
  return target
}

function lispProtectedSpans(text: string, offset: number): TextSpan[] {
  const spans: TextSpan[] = []
  for (let i = 0; i < text.length;) {
    if (text.startsWith("#|", i)) {
      const end = blockCommentEnd(text, i)
      spans.push({ start: offset + i, end: offset + end, face: "comment" })
      i = end
      continue
    }
    if (text[i] === ";") {
      const end = lineEnd(text, i)
      spans.push({ start: offset + i, end: offset + end, face: "comment" })
      i = end
      continue
    }
    if (text[i] === "\"") {
      let end = i + 1
      while (end < text.length) {
        if (text[end] === "\\") end += 2
        else if (text[end] === "\"") { end++; break }
        else end++
      }
      spans.push({ start: offset + i, end: offset + end, face: "string" })
      i = end
      continue
    }
    i++
  }
  return spans
}

function blockCommentEnd(text: string, start: number): number {
  let depth = 1
  let i = start + 2
  while (i < text.length && depth > 0) {
    if (text.startsWith("#|", i)) {
      depth++
      i += 2
    } else if (text.startsWith("|#", i)) {
      depth--
      i += 2
    } else {
      i++
    }
  }
  return i
}

function addMatches(text: string, regex: RegExp, face: TextSpan["face"], spans: TextSpan[], offset: number, avoidAnySpan = false, pred?: (word: string) => boolean): void {
  for (const match of text.matchAll(regex)) {
    const word = match[0]
    if (pred && !pred(word)) continue
    const start = offset + (match.index ?? 0)
    if (avoidAnySpan ? insideSpan(spans, start) : insideStringOrComment(spans, start)) continue
    spans.push({ start, end: start + word.length, face })
  }
}

function addGroupedMatches(text: string, regex: RegExp, face: TextSpan["face"], spans: TextSpan[], offset: number, group: number, avoidAnySpan = false): void {
  for (const match of text.matchAll(regex)) {
    const word = match[group] ?? match[0]
    const base = match.index ?? 0
    const start = offset + base + match[0].lastIndexOf(word)
    if (avoidAnySpan ? insideSpan(spans, start) : insideStringOrComment(spans, start)) continue
    spans.push({ start, end: start + word.length, face })
  }
}

function addGroupedDefinitionMatch(text: string, regex: RegExp, face: TextSpan["face"], spans: TextSpan[], offset: number): void {
  for (const match of text.matchAll(regex)) {
    const word = match[1] ?? match[2]
    if (!word) continue
    const base = match.index ?? 0
    const start = offset + base + match[0].lastIndexOf(word)
    if (insideSpan(spans, start)) continue
    spans.push({ start, end: start + word.length, face })
  }
}

function insideStringOrComment(spans: TextSpan[], point: number): boolean {
  return spans.some(span => point >= span.start && point < span.end && (span.face === "string" || span.face === "comment"))
}

function insideSpan(spans: TextSpan[], point: number): boolean {
  return spans.some(span => point >= span.start && point < span.end)
}

function lineEnd(text: string, start: number): number {
  const end = text.indexOf("\n", start)
  return end === -1 ? text.length : end
}

function fontLockSlice(buffer: BufferModel, range?: FontLockRange): { text: string; offset: number } {
  if (!range) return { text: buffer.text, offset: 0 }
  const startLine = Math.max(0, Math.min(range.startLine, buffer.lineCount - 1))
  const endLine = Math.max(startLine, Math.min(range.endLine, buffer.lineCount))
  const start = buffer.lineStarts[startLine] ?? 0
  const end = endLine < buffer.lineCount ? buffer.lineStarts[endLine]! : buffer.text.length
  return { text: buffer.text.slice(start, end), offset: start }
}
