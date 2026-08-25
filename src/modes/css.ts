import type { BufferModel } from "../kernel/buffer"
import { braceIndentLine } from "./generic"
import { defineMode, type FontLockRange, type ImenuIndexEntry, type TextSpan } from "./mode"

const selectorBeforeBrace = /([^{}/][^{;}]*)\{/g
const propertyName = /(^|[;{\n])([ \t]*)(--[-\w]+|[A-Za-z_][\w-]*)\s*:/g
const atRule = /@[A-Za-z-]+/g
const hexColor = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g
const numberWithUnit = /[-+]?(?:\d*\.\d+|\d+)(?:%|[A-Za-z]+)?\b/g
const important = /!\s*important\b/gi

export function installCssMode(): void {
  defineMode({
    name: "css-mode",
    parent: "prog-mode",
    commentStart: "/*",
    indentLine: cssIndentLine,
    fontLock: cssFontLock,
    imenuIndex: cssImenuIndex,
  })
  defineMode({ name: "scss-mode", parent: "css-mode", commentStart: "//" })
  defineMode({ name: "sass-mode", parent: "css-mode", commentStart: "//", indentLine: sassIndentLine })
}

export function cssIndentLine(buffer: BufferModel): void {
  braceIndentLine(buffer, 2)
}

export function sassIndentLine(buffer: BufferModel): void {
  const line = buffer.lineBoundsAt()
  const content = line.text.replace(/^\s*/, "")
  const oldIndent = line.text.length - content.length
  const column = buffer.point - line.start
  buffer.replaceRange(line.start, line.end, content)
  buffer.point = line.start + Math.max(0, column - oldIndent)
}

export function cssImenuIndex(buffer: BufferModel): ImenuIndexEntry[] {
  const entries: ImenuIndexEntry[] = []
  const protectedSpans = cssProtectedSpans(buffer.text, 0, buffer.mode !== "css-mode")
  for (const match of buffer.text.matchAll(selectorBeforeBrace)) {
    const base = match.index ?? 0
    const selector = (match[1] ?? "").trim()
    if (!selector || selector.startsWith("@")) continue
    const start = base + match[0].indexOf(selector)
    if (insideProtected(protectedSpans, start)) continue
    entries.push({ name: selector.replace(/\s+/g, " "), point: start })
  }
  return entries
}

export function cssFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const spans: TextSpan[] = []
  const { text, offset } = fontLockSlice(buffer, range)
  const protectedSpans = cssProtectedSpans(text, offset, buffer.mode !== "css-mode")
  spans.push(...protectedSpans)

  addCssSelectors(text, offset, spans)
  addCssProperties(text, offset, spans)
  addMatches(text, atRule, "keyword", spans, offset)
  addMatches(text, important, "keyword", spans, offset)
  addMatches(text, hexColor, "constant", spans, offset)
  addMatches(text, numberWithUnit, "number", spans, offset, true)

  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

function cssProtectedSpans(text: string, offset: number, lineComments: boolean): TextSpan[] {
  const spans: TextSpan[] = []
  for (let i = 0; i < text.length;) {
    if (text.startsWith("/*", i)) {
      const close = text.indexOf("*/", i + 2)
      const end = close === -1 ? text.length : close + 2
      spans.push({ start: offset + i, end: offset + end, face: "comment" })
      i = end
      continue
    }
    if (lineComments && text.startsWith("//", i) && isLineCommentStart(text, i)) {
      const end = lineEnd(text, i)
      spans.push({ start: offset + i, end: offset + end, face: "comment" })
      i = end
      continue
    }
    const ch = text[i]!
    if (ch === "\"" || ch === "'") {
      const quote = ch
      let end = i + 1
      while (end < text.length) {
        if (text[end] === "\\") end += 2
        else if (text[end] === quote) { end++; break }
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

function addCssSelectors(text: string, offset: number, spans: TextSpan[]): void {
  for (const match of text.matchAll(selectorBeforeBrace)) {
    const raw = match[1] ?? ""
    const selector = raw.trim()
    if (!selector || selector.startsWith("@")) continue
    const base = match.index ?? 0
    const start = offset + base + match[0].indexOf(selector)
    if (insideStringOrComment(spans, start)) continue
    spans.push({ start, end: start + selector.length, face: "function" })
  }
}

function addCssProperties(text: string, offset: number, spans: TextSpan[]): void {
  for (const match of text.matchAll(propertyName)) {
    const name = match[3] ?? ""
    const base = match.index ?? 0
    const localStart = base + match[0].lastIndexOf(name)
    const start = offset + localStart
    if (!isInsideDeclaration(text, localStart, spans, offset) || insideStringOrComment(spans, start)) continue
    spans.push({ start, end: start + name.length, face: "type" })
  }
}

function addMatches(text: string, regex: RegExp, face: TextSpan["face"], spans: TextSpan[], offset: number, avoidAnySpan = false): void {
  for (const match of text.matchAll(regex)) {
    const start = offset + (match.index ?? 0)
    if (avoidAnySpan ? insideProtected(spans, start) : insideStringOrComment(spans, start)) continue
    spans.push({ start, end: start + match[0].length, face })
  }
}

function isInsideDeclaration(text: string, point: number, spans: TextSpan[], offset: number): boolean {
  let depth = 0
  for (let i = 0; i < point; i++) {
    if (insideStringOrComment(spans, offset + i)) continue
    if (text[i] === "{") depth++
    else if (text[i] === "}") depth = Math.max(0, depth - 1)
  }
  return depth > 0
}

function isLineCommentStart(text: string, index: number): boolean {
  return index === 0 || /\s/.test(text[index - 1]!)
}

function insideProtected(spans: TextSpan[], point: number): boolean {
  return spans.some(span => point >= span.start && point < span.end)
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
