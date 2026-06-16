import type { BufferModel } from "../kernel/buffer"
import { Keymap } from "../kernel/keymap"
import { defineMode, type CompletionCandidate } from "./mode"
import { createTreeSitterFontLock } from "./tree-sitter"
import { codeFontLock } from "./generic"

const pythonKeywords = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield", "match", "case",
])

const pythonBuiltins = new Set([
  "abs", "all", "any", "bool", "bytes", "dict", "enumerate", "Exception", "filter", "float", "int", "len", "list", "map", "object", "open", "print", "range", "repr", "reversed", "set", "str", "sum", "super", "tuple", "type", "zip", "self", "cls",
])

const dedentStarters = /^(elif|else|except|finally|case)\b/
const dedentKeywords = /^(return|raise|break|continue|pass)\b/
const blockOpeners = /:\s*(#.*)?$/
const defunRegex = /^[ \t]*(async\s+def|def|class)\s+([A-Za-z_]\w*)/gm

export function installPythonMode(): void {
  const keymap = new Keymap("python-map")
  keymap.bind("C-M-a", "beginning-of-defun")
  keymap.bind("C-M-e", "end-of-defun")
  defineMode({
    name: "python",
    parent: "prog-mode",
    commentStart: "#",
    keymap,
    indentLine: pythonIndentLine,
    fontLock: (buffer, range) => {
      const ts = createTreeSitterFontLock("python")(buffer, range)
      return ts.length ? ts : codeFontLock(buffer, pythonKeywords, "#", range)
    },
    completeAtPoint: pythonCompleteAtPoint,
    beginningOfDefun: pythonBeginningOfDefun,
    endOfDefun: pythonEndOfDefun,
  })
}

export function pythonIndentLine(buffer: BufferModel): void {
  const line = buffer.lineBoundsAt()
  const desired = pythonDesiredIndent(buffer.text, line.start)
  const content = line.text.replace(/^\s*/, "")
  const column = buffer.point - line.start
  const oldIndent = line.text.length - content.length
  buffer.replaceRange(line.start, line.end, " ".repeat(desired) + content)
  buffer.point = line.start + Math.max(desired, column + desired - oldIndent)
}

export function pythonBeginningOfDefun(buffer: BufferModel): void {
  let target = 0
  for (const match of buffer.text.matchAll(defunRegex)) {
    if (match.index == null || match.index >= buffer.point) break
    target = match.index
  }
  buffer.point = target
}

export function pythonEndOfDefun(buffer: BufferModel): void {
  const start = findCurrentDefunStart(buffer)
  const baseIndent = indentationAt(buffer.text, start)
  const nextLine = buffer.text.indexOf("\n", start)
  if (nextLine === -1) {
    buffer.point = buffer.text.length
    return
  }
  let offset = nextLine + 1
  while (offset < buffer.text.length) {
    const end = lineEnd(buffer.text, offset)
    const line = buffer.text.slice(offset, end)
    if (line.trim() && indentation(line) <= baseIndent) {
      buffer.point = offset
      return
    }
    offset = end + 1
  }
  buffer.point = buffer.text.length
}

export function pythonCompleteAtPoint(buffer: BufferModel): CompletionCandidate[] {
  const symbol = buffer.symbolBoundsAt()
  if (!symbol.text) return []
  const words = new Set([...pythonKeywords, ...pythonBuiltins])
  for (const match of buffer.text.matchAll(/\b[A-Za-z_]\w*\b/g)) words.add(match[0])
  return [...words]
    .filter(word => word.startsWith(symbol.text) && word !== symbol.text)
    .sort()
    .map(text => ({ text, start: symbol.start, end: symbol.end }))
}

function pythonDesiredIndent(text: string, lineStart: number): number {
  const currentLine = text.slice(lineStart, lineEnd(text, lineStart)).trim()
  let previousStart = previousCodeLineStart(text, lineStart)
  if (previousStart == null) return 0
  let indent = indentationAt(text, previousStart)
  const previous = text.slice(previousStart, lineEnd(text, previousStart)).trim()
  if (blockOpeners.test(previous)) indent += 4
  if (dedentKeywords.test(previous)) indent = Math.max(0, indent - 4)
  if (dedentStarters.test(currentLine)) indent = Math.max(0, indent - 4)
  return indent
}

function previousCodeLineStart(text: string, before: number): number | null {
  let cursor = Math.max(0, before - 1)
  while (cursor > 0) {
    const start = text.lastIndexOf("\n", cursor - 1) + 1
    const line = text.slice(start, lineEnd(text, start)).trim()
    if (line && !line.startsWith("#")) return start
    if (start === 0) break
    cursor = start - 1
  }
  return null
}

function findCurrentDefunStart(buffer: BufferModel): number {
  let target = 0
  for (const match of buffer.text.matchAll(defunRegex)) {
    if (match.index == null || match.index > buffer.point) break
    target = match.index
  }
  return target
}

function indentationAt(text: string, start: number): number {
  return indentation(text.slice(start, lineEnd(text, start)))
}

function indentation(line: string): number {
  return line.match(/^\s*/)?.[0].replace(/\t/g, "    ").length ?? 0
}

function lineEnd(text: string, start: number): number {
  const end = text.indexOf("\n", start)
  return end === -1 ? text.length : end
}
