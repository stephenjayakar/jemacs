import type { BufferModel } from "../kernel/buffer"
import { defineMode, type FontLockRange, type TextSpan } from "./mode"

type Line = { text: string; start: number; end: number }

const cmakeCommands = new Set([
  "add_executable", "add_library", "add_subdirectory", "cmake_minimum_required", "else", "elseif", "endforeach", "endfunction", "endif", "endmacro", "find_package", "foreach", "function", "if", "include", "install", "macro", "message", "option", "project", "set", "target_link_libraries",
])

const cmakeBlockOpeners = new Set(["if", "foreach", "function", "macro"])
const cmakeBlockMiddles = new Set(["else", "elseif"])
const cmakeBlockClosers = new Set(["endif", "endforeach", "endfunction", "endmacro"])
const cmakeArgumentKeywords = new Set(["INTERFACE", "PRIVATE", "PUBLIC", "REQUIRED", "SHARED", "STATIC"])

const identifierBeforeParen = /\b([A-Za-z_][A-Za-z0-9_]*)\s*(?=\()/g
const variableReference = /\$\{[^}\n]+}/g
const uppercaseArgumentKeyword = /\b[A-Z][A-Z0-9_]*\b/g

export function installCmakeMode(): void {
  defineMode({
    name: "cmake-mode",
    parent: "prog-mode",
    commentStart: "#",
    indentLine: cmakeIndentLine,
    fontLock: cmakeFontLock,
  })
}

export function cmakeIndentLine(buffer: BufferModel): void {
  const line = buffer.lineBoundsAt()
  const content = line.text.replace(/^[ \t]*/, "")
  const depth = cmakeBlockDepthBefore(buffer.text, line.start)
  const command = cmakeCommandName(content)
  const desiredDepth = command && (cmakeBlockClosers.has(command) || cmakeBlockMiddles.has(command)) ? Math.max(0, depth - 1) : depth
  const desired = " ".repeat(desiredDepth * 2)
  const oldIndent = line.text.length - content.length
  const column = buffer.point - line.start
  buffer.replaceRange(line.start, line.end, desired + content)
  buffer.point = line.start + Math.max(desired.length, column + desired.length - oldIndent)
}

export function cmakeFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const spans: TextSpan[] = []
  const { text, offset } = fontLockSlice(buffer, range)
  spans.push(...cmakeProtectedSpans(text, offset))

  for (const line of textLines(text)) addStatementCommandSpan(line.text, offset + line.start, spans)
  addIdentifierBeforeParenSpans(text, offset, spans)
  addMatches(text, variableReference, "builtin", spans, offset, insideComment)
  addMatches(text, uppercaseArgumentKeyword, "keyword", spans, offset, (spanList, point) => insideStringOrComment(spanList, point), word => cmakeArgumentKeywords.has(word))

  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

function cmakeProtectedSpans(text: string, offset: number): TextSpan[] {
  const spans: TextSpan[] = []
  for (let i = 0; i < text.length;) {
    const ch = text[i]!
    if (ch === "#") {
      const end = lineEnd(text, i)
      spans.push({ start: offset + i, end: offset + end, face: "comment" })
      i = end
      continue
    }
    if (ch === "\"") {
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

function addStatementCommandSpan(text: string, offset: number, spans: TextSpan[]): void {
  const trimmedStart = firstNonWhitespace(text, 0)
  if (trimmedStart === -1) return
  const match = text.slice(trimmedStart).match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
  const command = match?.[1]
  if (!command) return
  const start = offset + trimmedStart
  if (insideStringOrComment(spans, start)) return
  spans.push({ start, end: start + command.length, face: cmakeCommands.has(command.toLowerCase()) ? "keyword" : "function" })
}

function addIdentifierBeforeParenSpans(text: string, offset: number, spans: TextSpan[]): void {
  for (const match of text.matchAll(identifierBeforeParen)) {
    const word = match[1]!
    const start = offset + (match.index ?? 0)
    if (insideSpan(spans, start) || insideStringOrComment(spans, start)) continue
    spans.push({ start, end: start + word.length, face: "function" })
  }
}

function addMatches(
  text: string,
  regex: RegExp,
  face: TextSpan["face"],
  spans: TextSpan[],
  offset: number,
  blocked: (spans: TextSpan[], point: number) => boolean,
  pred?: (word: string) => boolean,
): void {
  for (const match of text.matchAll(regex)) {
    const word = match[0]
    if (pred && !pred(word)) continue
    const start = offset + (match.index ?? 0)
    if (!blocked(spans, start)) spans.push({ start, end: start + word.length, face })
  }
}

function cmakeBlockDepthBefore(text: string, lineStart: number): number {
  let depth = 0
  for (const line of textLines(text.slice(0, lineStart))) {
    const command = cmakeCommandName(line.text)
    if (!command) continue
    if (cmakeBlockClosers.has(command)) depth = Math.max(0, depth - 1)
    else if (cmakeBlockOpeners.has(command)) depth++
  }
  return depth
}

function cmakeCommandName(text: string): string | null {
  const commentAt = cmakeCommentStart(text)
  const content = text.slice(0, commentAt === -1 ? text.length : commentAt).trimStart()
  const match = content.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
  return match?.[1]?.toLowerCase() ?? null
}

function cmakeCommentStart(text: string): number {
  let escaped = false
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === "\"") inString = false
      continue
    }
    if (ch === "\"") {
      inString = true
      continue
    }
    if (ch === "#") return i
  }
  return -1
}

function firstNonWhitespace(text: string, start: number): number {
  for (let i = start; i < text.length; i++) if (!/\s/.test(text[i]!)) return i
  return -1
}

function insideStringOrComment(spans: TextSpan[], point: number): boolean {
  return spans.some(span => point >= span.start && point < span.end && (span.face === "string" || span.face === "comment"))
}

function insideComment(spans: TextSpan[], point: number): boolean {
  return spans.some(span => point >= span.start && point < span.end && span.face === "comment")
}

function insideSpan(spans: TextSpan[], point: number): boolean {
  return spans.some(span => point >= span.start && point < span.end)
}

function textLines(text: string): Line[] {
  const lines: Line[] = []
  let start = 0
  while (start <= text.length) {
    const end = lineEnd(text, start)
    lines.push({ text: text.slice(start, end), start, end })
    if (end === text.length) break
    start = end + 1
  }
  return lines
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
