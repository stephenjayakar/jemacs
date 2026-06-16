import type { BufferModel } from "../kernel/buffer"
import { Keymap } from "../kernel/keymap"
import { defineMode, type CompletionCandidate, type FontLockRange, type TextSpan } from "./mode"

const emacsLispKeywords = new Set([
  "and", "catch", "cond", "condition-case", "defconst", "defcustom", "defface", "defgroup", "define-derived-mode", "define-key", "define-minor-mode", "defmacro", "defun", "defvar", "function", "if", "interactive", "lambda", "let", "let*", "or", "prog1", "prog2", "progn", "quote", "save-excursion", "save-restriction", "setq", "setq-default", "unwind-protect", "while",
])

const emacsLispBuiltins = new Set([
  "add-hook", "apply", "autoload", "buffer-file-name", "car", "cdr", "cons", "eq", "equal", "eval-after-load", "expand-file-name", "find-file", "format", "funcall", "global-set-key", "list", "load-file", "mapcar", "message", "nil", "not", "point", "provide", "require", "t",
])

const defunRegex = /^[ \t]*\((?:cl-)?(?:defun|defmacro|defvar|defconst|defcustom|defface|defgroup|define-[\w-]+)\s+([^\s()]+)/gm
const specialForms = new Set(["cond", "condition-case", "defcustom", "defface", "defgroup", "defmacro", "defun", "defvar", "defconst", "if", "lambda", "let", "let*", "progn", "save-excursion", "save-restriction", "unwind-protect", "when", "while", "with-current-buffer", "with-temp-buffer"])

export function installEmacsLispMode(): void {
  const keymap = new Keymap("emacs-lisp-mode-map")
  keymap.bind("C-M-a", "beginning-of-defun")
  keymap.bind("C-M-e", "end-of-defun")

  defineMode({
    name: "emacs-lisp-mode",
    parent: "prog-mode",
    commentStart: ";",
    keymap,
    indentLine: emacsLispIndentLine,
    fontLock: emacsLispFontLock,
    completeAtPoint: emacsLispCompleteAtPoint,
    beginningOfDefun: emacsLispBeginningOfDefun,
    endOfDefun: emacsLispEndOfDefun,
  })
}

export function emacsLispIndentLine(buffer: BufferModel): void {
  const line = buffer.lineBoundsAt()
  const desired = emacsLispDesiredIndent(buffer.text, line.start)
  const content = line.text.replace(/^\s*/, "")
  const column = buffer.point - line.start
  const oldIndent = line.text.length - content.length
  buffer.replaceRange(line.start, line.end, " ".repeat(desired) + content)
  buffer.point = line.start + Math.max(desired, column + desired - oldIndent)
}

export function emacsLispBeginningOfDefun(buffer: BufferModel): void {
  let target = 0
  for (const match of buffer.text.matchAll(defunRegex)) {
    if (match.index == null || match.index >= buffer.point) break
    target = match.index
  }
  buffer.point = target
}

export function emacsLispEndOfDefun(buffer: BufferModel): void {
  const start = findCurrentDefunStart(buffer)
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < buffer.text.length; i++) {
    const ch = buffer.text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === "\"") inString = false
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
  }
  buffer.point = buffer.text.length
}

export function emacsLispFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const spans: TextSpan[] = []
  const { text, offset } = fontLockSlice(buffer, range)
  for (let i = 0; i < text.length;) {
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
  addSymbols(text, /\b-?\d+(?:\.\d+)?\b/g, "number", spans, undefined, 0, offset)
  addSymbols(text, /\((?:cl-)?(?:defun|defmacro)\s+([^\s()]+)/g, "function", spans, undefined, 1, offset)
  addSymbols(text, /\((?:defvar|defconst|defcustom)\s+([^\s()]+)/g, "constant", spans, undefined, 1, offset)
  addSymbols(text, /\b[\w-]+\b/g, "keyword", spans, word => emacsLispKeywords.has(word), 0, offset)
  addSymbols(text, /\b[\w-]+\b/g, "builtin", spans, word => emacsLispBuiltins.has(word), 0, offset)
  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

export function emacsLispCompleteAtPoint(buffer: BufferModel): CompletionCandidate[] {
  const symbol = lispSymbolBoundsAt(buffer)
  if (!symbol.text) return []
  const words = new Set([...emacsLispKeywords, ...emacsLispBuiltins])
  for (const match of buffer.text.matchAll(/[\w-]+/g)) words.add(match[0])
  return [...words]
    .filter(word => word.startsWith(symbol.text) && word !== symbol.text)
    .sort()
    .map(text => ({ text, start: symbol.start, end: symbol.end }))
}

function emacsLispDesiredIndent(text: string, lineStart: number): number {
  const current = text.slice(lineStart, lineEnd(text, lineStart)).trim()
  if (current.startsWith(")")) return Math.max(0, openListColumnBefore(text, lineStart) ?? 0)
  const open = innermostOpenList(text, lineStart)
  if (!open) return 0
  if (open.symbol && specialForms.has(open.symbol)) return open.column + 2
  return open.afterSymbolColumn ?? open.column + 1
}

function innermostOpenList(text: string, before: number): { index: number; column: number; symbol?: string; afterSymbolColumn?: number } | null {
  const stack: number[] = []
  let inString = false
  let escaped = false
  for (let i = 0; i < before; i++) {
    const ch = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === "\"") inString = false
      continue
    }
    if (ch === ";") {
      i = lineEnd(text, i)
      continue
    }
    if (ch === "\"") inString = true
    else if (ch === "(") stack.push(i)
    else if (ch === ")") stack.pop()
  }
  const index = stack.at(-1)
  if (index == null) return null
  const symbolMatch = text.slice(index + 1, lineEnd(text, index)).match(/^\s*([^\s()]+)/)
  const symbol = symbolMatch?.[1]
  const symbolStart = symbol ? index + 1 + (symbolMatch![0].indexOf(symbol)) : undefined
  return {
    index,
    column: columnAt(text, index),
    symbol,
    afterSymbolColumn: symbolStart == null || !symbol ? undefined : columnAt(text, symbolStart + symbol.length) + 1,
  }
}

function openListColumnBefore(text: string, before: number): number | null {
  return innermostOpenList(text, before)?.column ?? null
}

function findCurrentDefunStart(buffer: BufferModel): number {
  let target = 0
  for (const match of buffer.text.matchAll(defunRegex)) {
    if (match.index == null || match.index > buffer.point) break
    target = match.index
  }
  return target
}

function lispSymbolBoundsAt(buffer: BufferModel): { start: number; end: number; text: string } {
  const isSymbol = (ch: string) => /[\w-]/.test(ch)
  let start = Math.max(0, Math.min(buffer.point, buffer.text.length))
  let end = start
  while (start > 0 && isSymbol(buffer.text[start - 1]!)) start--
  while (end < buffer.text.length && isSymbol(buffer.text[end]!)) end++
  return { start, end, text: buffer.text.slice(start, end) }
}

function addSymbols(text: string, regex: RegExp, face: TextSpan["face"], spans: TextSpan[], pred?: (word: string) => boolean, group = 0, offset = 0): void {
  for (const match of text.matchAll(regex)) {
    const word = match[group] ?? match[0]
    if (pred && !pred(word)) continue
    const base = match.index ?? 0
    const start = offset + (group ? base + match[0].lastIndexOf(word) : base)
    if (!insideStringOrComment(spans, start)) spans.push({ start, end: start + word.length, face })
  }
}

function insideStringOrComment(spans: TextSpan[], point: number): boolean {
  return spans.some(span => point >= span.start && point < span.end && (span.face === "string" || span.face === "comment"))
}

function columnAt(text: string, index: number): number {
  const lineStart = text.lastIndexOf("\n", Math.max(0, index - 1)) + 1
  return text.slice(lineStart, index).replace(/\t/g, "        ").length
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
