import type { BufferModel } from "../kernel/buffer"
import { Keymap } from "../kernel/keymap"
import { defineMode, type CompletionCandidate, type FontLockRange, type TextSpan } from "./mode"

const shellKeywords = new Set([
  "case", "do", "done", "elif", "else", "esac", "fi", "for", "function", "if", "in", "select", "then", "time", "until", "while",
])

const shellBuiltins = new Set([
  "alias", "bg", "bind", "break", "builtin", "caller", "cd", "command", "compgen", "complete", "continue", "declare", "dirs", "disown", "echo", "enable", "eval", "exec", "exit", "export", "fc", "fg", "getopts", "hash", "help", "history", "jobs", "kill", "let", "local", "logout", "mapfile", "popd", "printf", "pushd", "pwd", "read", "readonly", "return", "set", "shift", "shopt", "source", "test", "times", "trap", "type", "typeset", "ulimit", "umask", "unalias", "unset", "wait",
])

const blockOpeners = /\b(?:do|then)\s*(?:[#;].*)?$|(?:^|\s)case\b.*\bin\s*(?:[#;].*)?$|\{\s*(?:[#;].*)?$/
const blockClosers = /^(?:done|fi|esac|elif|else)\b|^\}/
const functionDefunRegex = /^[ \t]*(?:function\s+)?([A-Za-z_][\w-]*)\s*(?:\(\))?\s*\{/gm

export function installShellScriptMode(): void {
  const keymap = new Keymap("sh-mode-map")
  keymap.bind("C-M-a", "beginning-of-defun")
  keymap.bind("C-M-e", "end-of-defun")

  defineMode({
    name: "sh-mode",
    parent: "prog-mode",
    commentStart: "#",
    keymap,
    indentLine: shellScriptIndentLine,
    fontLock: shellScriptFontLock,
    completeAtPoint: shellScriptCompleteAtPoint,
    beginningOfDefun: shellScriptBeginningOfDefun,
    endOfDefun: shellScriptEndOfDefun,
  })
  defineMode({ name: "shell-script-mode", parent: "sh-mode" })
  defineMode({ name: "bash-mode", parent: "sh-mode" })
}

export function shellScriptIndentLine(buffer: BufferModel): void {
  const line = buffer.lineBoundsAt()
  const desired = shellScriptDesiredIndent(buffer.text, line.start)
  const content = line.text.replace(/^\s*/, "")
  const column = buffer.point - line.start
  const oldIndent = line.text.length - content.length
  buffer.replaceRange(line.start, line.end, " ".repeat(desired) + content)
  buffer.point = line.start + Math.max(desired, column + desired - oldIndent)
}

export function shellScriptBeginningOfDefun(buffer: BufferModel): void {
  let target = 0
  for (const match of buffer.text.matchAll(functionDefunRegex)) {
    if (match.index == null || match.index >= buffer.point) break
    target = match.index
  }
  buffer.point = target
}

export function shellScriptEndOfDefun(buffer: BufferModel): void {
  const start = findCurrentDefunStart(buffer)
  let depth = 0
  for (let i = start; i < buffer.text.length; i++) {
    const ch = buffer.text[i]!
    if (ch === "#") {
      i = lineEnd(buffer.text, i)
      continue
    }
    if (ch === "\"" || ch === "'" || ch === "`") {
      const quote = ch
      i++
      while (i < buffer.text.length) {
        if (quote !== "'" && buffer.text[i] === "\\") i += 2
        else if (buffer.text[i] === quote) break
        else i++
      }
      continue
    }
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth <= 0) {
        buffer.point = i + 1
        return
      }
    }
  }
  buffer.point = buffer.text.length
}

export function shellScriptFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const spans: TextSpan[] = []
  const { text, offset } = fontLockSlice(buffer, range)
  for (let i = 0; i < text.length;) {
    if (text[i] === "#") {
      const end = lineEnd(text, i)
      spans.push({ start: offset + i, end: offset + end, face: "comment" })
      i = end
      continue
    }
    const ch = text[i]!
    if (ch === "\"" || ch === "'" || ch === "`") {
      const quote = ch
      let end = i + 1
      while (end < text.length) {
        if (quote !== "'" && text[end] === "\\") end += 2
        else if (text[end] === quote) { end++; break }
        else end++
      }
      spans.push({ start: offset + i, end: offset + end, face: "string" })
      i = end
      continue
    }
    i++
  }
  addWords(text, /\b\d+\b/g, "number", spans, undefined, 0, offset)
  addWords(text, /\b[A-Za-z_][\w-]*\b/g, "keyword", spans, word => shellKeywords.has(word), 0, offset)
  addWords(text, /\b[A-Za-z_][\w-]*\b/g, "builtin", spans, word => shellBuiltins.has(word), 0, offset)
  addWords(text, functionDefunRegex, "function", spans, undefined, 1, offset)
  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

export function shellScriptCompleteAtPoint(buffer: BufferModel): CompletionCandidate[] {
  const symbol = buffer.symbolBoundsAt()
  if (!symbol.text) return []
  const words = new Set([...shellKeywords, ...shellBuiltins])
  for (const match of buffer.text.matchAll(/\b[A-Za-z_][\w-]*\b/g)) words.add(match[0])
  return [...words]
    .filter(word => word.startsWith(symbol.text) && word !== symbol.text)
    .sort()
    .map(text => ({ text, start: symbol.start, end: symbol.end }))
}

function shellScriptDesiredIndent(text: string, lineStart: number): number {
  const current = text.slice(lineStart, lineEnd(text, lineStart)).trim()
  let indent = 0
  let start = 0
  while (start < lineStart) {
    const end = lineEnd(text, start)
    const line = text.slice(start, end).trim()
    if (line && !line.startsWith("#")) {
      if (blockClosers.test(line)) indent = Math.max(0, indent - 2)
      if (blockOpeners.test(line)) indent += 2
    }
    start = end + 1
  }
  if (blockClosers.test(current)) indent = Math.max(0, indent - 2)
  return indent
}

function findCurrentDefunStart(buffer: BufferModel): number {
  let target = 0
  for (const match of buffer.text.matchAll(functionDefunRegex)) {
    if (match.index == null || match.index > buffer.point) break
    target = match.index
  }
  return target
}

function addWords(text: string, regex: RegExp, face: TextSpan["face"], spans: TextSpan[], pred?: (word: string) => boolean, group = 0, offset = 0): void {
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
