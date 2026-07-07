import type { BufferModel } from "../kernel/buffer"
import { defineMode, type FontLockRange, type TextSpan } from "./mode"

type Line = { text: string; start: number; end: number }
type FontLockBounds = { start: number; end: number }

const hyperlinkTargetRegex = /^\s*(\.\.\s+_[^:\n]+:)/
const directiveRegex = /^\s*(\.\.\s+[A-Za-z][A-Za-z0-9_-]*::)/
const fieldListRegex = /^\s*(:[^:\n]+:)/
const inlineLiteralRegex = /``[^`\n]+``/g
const strongEmphasisRegex = /(^|[^\w*])(\*\*[^*\s](?:[^*\n]*?[^*\s])?\*\*)(?![\w*])/g
const emphasisRegex = /(^|[^\w*])(\*[^*\s](?:[^*\n]*?[^*\s])?\*)(?![\w*])/g

export function installRstMode(): void {
  defineMode({
    name: "rst-mode",
    parent: "text",
    commentStart: "..",
    fontLock: rstFontLock,
  })
}

export function rstFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const spans: TextSpan[] = []
  const bounds = fontLockBounds(buffer, range)
  const lines = textLines(buffer.text)
  addSectionTitleSpans(lines, spans, bounds)

  for (const line of lines) {
    if (!lineIntersects(line, bounds)) continue
    addLineMarkupSpans(line, spans, bounds)
    addInlineSpans(line, spans, bounds)
  }

  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

function addSectionTitleSpans(lines: Line[], spans: TextSpan[], bounds: FontLockBounds): void {
  for (let i = 0; i + 1 < lines.length; i++) {
    const title = lines[i]!
    const underline = lines[i + 1]!
    const titleText = title.text.trim()
    if (!titleText || underlineLike(title.text)) continue
    const underlineMatch = underline.text.match(/^\s*([=\-~])\1*\s*$/)
    if (!underlineMatch) continue
    const underlineStart = firstNonWhitespace(underline.text, 0)
    if (underlineStart === -1) continue
    const underlineEnd = trimRightIndex(underline.text, underline.text.length)
    if (underlineEnd - underlineStart < titleText.length) continue

    const titleStart = firstNonWhitespace(title.text, 0)
    const titleEnd = trimRightIndex(title.text, title.text.length)
    if (titleStart !== -1) addSpan(spans, title.start + titleStart, title.start + titleEnd, "type", bounds)
    addSpan(spans, underline.start + underlineStart, underline.start + underlineEnd, "type", bounds)
  }
}

function addLineMarkupSpans(line: Line, spans: TextSpan[], bounds: FontLockBounds): void {
  const target = line.text.match(hyperlinkTargetRegex)
  if (target) {
    addGroupSpan(line, target, 1, "constant", spans, bounds)
    return
  }

  const directive = line.text.match(directiveRegex)
  if (directive) {
    addGroupSpan(line, directive, 1, "keyword", spans, bounds)
    return
  }

  const field = line.text.match(fieldListRegex)
  if (field) addGroupSpan(line, field, 1, "constant", spans, bounds)

  if (isLiteralBlockLine(line.text)) {
    const start = line.start + line.text.lastIndexOf("::")
    addSpan(spans, start, start + 2, "string", bounds)
  }
}

function addInlineSpans(line: Line, spans: TextSpan[], bounds: FontLockBounds): void {
  addMatches(line.text, inlineLiteralRegex, "string", spans, line.start, bounds, 0, true)
  addMatches(line.text, strongEmphasisRegex, "keyword", spans, line.start, bounds, 2)
  addMatches(line.text, emphasisRegex, "keyword", spans, line.start, bounds, 2)
}

function addMatches(
  text: string,
  regex: RegExp,
  face: TextSpan["face"],
  spans: TextSpan[],
  offset: number,
  bounds: FontLockBounds,
  group = 0,
  allowInsideSpan = false,
): void {
  regex.lastIndex = 0
  for (const match of text.matchAll(regex)) {
    const value = match[group] ?? match[0]
    const relativeStart = (match.index ?? 0) + match[0].indexOf(value)
    const start = offset + relativeStart
    const end = start + value.length
    if (!allowInsideSpan && insideSpan(spans, start)) continue
    addSpan(spans, start, end, face, bounds)
  }
}

function addGroupSpan(line: Line, match: RegExpMatchArray, group: number, face: TextSpan["face"], spans: TextSpan[], bounds: FontLockBounds): void {
  const value = match[group] ?? match[0]
  const start = line.start + match[0].indexOf(value)
  addSpan(spans, start, start + value.length, face, bounds)
}

function addSpan(spans: TextSpan[], start: number, end: number, face: TextSpan["face"], bounds: FontLockBounds): void {
  if (start >= end || end <= bounds.start || start >= bounds.end) return
  spans.push({ start, end, face })
}

function insideSpan(spans: TextSpan[], point: number): boolean {
  return spans.some(span => point >= span.start && point < span.end)
}

function isLiteralBlockLine(text: string): boolean {
  if (!text.trimEnd().endsWith("::")) return false
  if (hyperlinkTargetRegex.test(text) || directiveRegex.test(text)) return false
  const index = text.lastIndexOf("::")
  return text[index - 1] !== ":"
}

function underlineLike(text: string): boolean {
  return /^\s*[=\-~]+\s*$/.test(text)
}

function lineIntersects(line: Line, bounds: FontLockBounds): boolean {
  return line.end >= bounds.start && line.start < bounds.end
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

function fontLockBounds(buffer: BufferModel, range?: FontLockRange): FontLockBounds {
  if (!range) return { start: 0, end: buffer.text.length }
  const startLine = Math.max(0, Math.min(range.startLine, buffer.lineCount - 1))
  const endLine = Math.max(startLine, Math.min(range.endLine, buffer.lineCount))
  const start = buffer.lineStarts[startLine] ?? 0
  const end = endLine < buffer.lineCount ? buffer.lineStarts[endLine]! : buffer.text.length
  return { start, end }
}
