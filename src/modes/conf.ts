import type { BufferModel } from "../kernel/buffer"
import { defineMode, type FontLockRange, type ImenuIndexEntry, type TextSpan } from "./mode"

type Line = { text: string; start: number; end: number }

export function installConfMode(): void {
  defineMode({
    name: "conf-mode",
    parent: "text",
    commentStart: "#",
    indentLine: confIndentLine,
    fontLock: confFontLock,
    imenuIndex: confImenuIndex,
  })
  defineMode({ name: "conf-unix-mode", parent: "conf-mode", commentStart: "#", fontLock: confFontLock })
  defineMode({ name: "conf-windows-mode", parent: "conf-mode", commentStart: ";", fontLock: confWindowsFontLock })
  defineMode({ name: "conf-space-mode", parent: "conf-mode", commentStart: "#", fontLock: confSpaceFontLock })
}

export function confIndentLine(_buffer: BufferModel): void {
  // Configuration files have no structural indentation in these modes.
}

export function confFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  return confFontLockWithComments(buffer, ["#"], false, range)
}

export function confWindowsFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  return confFontLockWithComments(buffer, [";"], false, range)
}

export function confSpaceFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  return confFontLockWithComments(buffer, ["#"], true, range)
}

export function confImenuIndex(buffer: BufferModel): ImenuIndexEntry[] {
  const entries: ImenuIndexEntry[] = []
  for (const line of textLines(buffer.text)) {
    const commentAt = commentStartInLine(line.text, ["#"])
    const content = line.text.slice(0, commentAt === -1 ? line.text.length : commentAt)
    const section = content.match(/^\s*(\[[^\]\n]+\])/)
    if (section) entries.push({ name: section[1]!.slice(1, -1), point: line.start + content.indexOf(section[1]!) })
  }
  return entries
}

function confFontLockWithComments(buffer: BufferModel, commentChars: string[], spaceSeparated: boolean, range?: FontLockRange): TextSpan[] {
  const spans: TextSpan[] = []
  const { text, offset } = fontLockSlice(buffer, range)
  for (const line of textLines(text)) {
    const commentAt = commentStartInLine(line.text, commentChars)
    const contentEnd = commentAt === -1 ? line.text.length : commentAt
    const content = line.text.slice(0, contentEnd)
    if (commentAt !== -1) spans.push({ start: offset + line.start + commentAt, end: offset + line.end, face: "comment" })

    const section = content.match(/^\s*(\[[^\]\n]+\])/)
    if (section) {
      const start = offset + line.start + content.indexOf(section[1]!)
      spans.push({ start, end: start + section[1]!.length, face: "type" })
      continue
    }

    const separator = firstSeparator(content)
    if (separator !== -1) {
      addKeyValueSpans(content, separator, offset + line.start, spans)
      continue
    }

    if (spaceSeparated) addSpaceSeparatedSpans(content, offset + line.start, spans)
  }
  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

function addKeyValueSpans(content: string, separator: number, offset: number, spans: TextSpan[]): void {
  const keyStart = firstNonWhitespace(content, 0)
  const keyEnd = trimRightIndex(content, separator)
  if (keyStart !== -1 && keyStart < keyEnd) spans.push({ start: offset + keyStart, end: offset + keyEnd, face: "constant" })

  const valueStart = firstNonWhitespace(content, separator + 1)
  const valueEnd = trimRightIndex(content, content.length)
  if (valueStart !== -1 && valueStart < valueEnd) spans.push({ start: offset + valueStart, end: offset + valueEnd, face: "string" })
}

function addSpaceSeparatedSpans(content: string, offset: number, spans: TextSpan[]): void {
  const match = content.match(/^\s*(\S+)(\s+)(.*?)\s*$/)
  if (!match || !match[3]) return
  const keyStart = content.indexOf(match[1]!)
  const valueStart = keyStart + match[1]!.length + match[2]!.length
  const valueEnd = trimRightIndex(content, content.length)
  spans.push({ start: offset + keyStart, end: offset + keyStart + match[1]!.length, face: "constant" })
  if (valueStart < valueEnd) spans.push({ start: offset + valueStart, end: offset + valueEnd, face: "string" })
}

function firstSeparator(text: string): number {
  const equals = text.indexOf("=")
  const colon = text.indexOf(":")
  if (equals === -1) return colon
  if (colon === -1) return equals
  return Math.min(equals, colon)
}

function commentStartInLine(text: string, commentChars: string[]): number {
  let quote: string | null = null
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "\"" || ch === "'") {
      quote = ch
      continue
    }
    if (commentChars.includes(ch)) return i
  }
  return -1
}

function firstNonWhitespace(text: string, start: number): number {
  for (let i = start; i < text.length; i++) if (!/\s/.test(text[i]!)) return i
  return -1
}

function trimRightIndex(text: string, end: number): number {
  while (end > 0 && /\s/.test(text[end - 1]!)) end--
  return end
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
