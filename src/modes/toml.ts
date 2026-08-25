import type { BufferModel } from "../kernel/buffer"
import { defineMode, type FontLockRange, type TextSpan } from "./mode"

const tableHeader = /^\s*(\[\[?[^\]\n]+\]\]?)/gm
const keyName = /^\s*([A-Za-z0-9_-]+(?:\s*\.\s*[A-Za-z0-9_-]+)*)\s*=/gm
const booleanLiteral = /\b(?:true|false)\b/g
const dateLiteral = /\b\d{4}-\d{2}-\d{2}(?:[Tt ][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.\d+)?(?:Z|[+-][0-9]{2}:[0-9]{2})?)?\b/g
const numberLiteral = /[+-]?(?:0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?)(?![\w-])/g

export function installTomlMode(): void {
  defineMode({
    name: "toml-mode",
    parent: "prog-mode",
    commentStart: "#",
    indentLine: tomlIndentLine,
    fontLock: tomlFontLock,
  })
}

export function tomlIndentLine(buffer: BufferModel): void {
  const line = buffer.lineBoundsAt()
  const content = line.text.replace(/^\s*/, "")
  const oldIndent = line.text.length - content.length
  const column = buffer.point - line.start
  buffer.replaceRange(line.start, line.end, content)
  buffer.point = line.start + Math.max(0, column - oldIndent)
}

export function tomlFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const spans: TextSpan[] = []
  const { text, offset } = fontLockSlice(buffer, range)
  spans.push(...tomlProtectedSpans(text, offset))

  addGroupedMatches(text, tableHeader, "type", spans, offset, 1, true)
  addGroupedMatches(text, keyName, "keyword", spans, offset, 1)
  addMatches(text, booleanLiteral, "keyword", spans, offset)
  addMatches(text, dateLiteral, "constant", spans, offset)
  addMatches(text, numberLiteral, "number", spans, offset, true)

  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

function tomlProtectedSpans(text: string, offset: number): TextSpan[] {
  const spans: TextSpan[] = []
  for (let i = 0; i < text.length;) {
    if (text.startsWith("\"\"\"", i) || text.startsWith("'''", i)) {
      const delimiter = text.slice(i, i + 3)
      const close = text.indexOf(delimiter, i + 3)
      const end = close === -1 ? text.length : close + 3
      spans.push({ start: offset + i, end: offset + end, face: "string" })
      i = end
      continue
    }
    const ch = text[i]!
    if (ch === "\"" || ch === "'") {
      const quote = ch
      let end = i + 1
      while (end < text.length) {
        if (quote === "\"" && text[end] === "\\") end += 2
        else if (text[end] === quote) { end++; break }
        else end++
      }
      spans.push({ start: offset + i, end: offset + end, face: "string" })
      i = end
      continue
    }
    if (ch === "#") {
      const end = lineEnd(text, i)
      spans.push({ start: offset + i, end: offset + end, face: "comment" })
      i = end
      continue
    }
    i++
  }
  return spans
}

function addMatches(text: string, regex: RegExp, face: TextSpan["face"], spans: TextSpan[], offset: number, avoidAnySpan = false): void {
  for (const match of text.matchAll(regex)) {
    const start = offset + (match.index ?? 0)
    if (avoidAnySpan ? insideSpan(spans, start) : insideStringOrComment(spans, start)) continue
    spans.push({ start, end: start + match[0].length, face })
  }
}

function addGroupedMatches(text: string, regex: RegExp, face: TextSpan["face"], spans: TextSpan[], offset: number, group: number, avoidAnySpan = false): void {
  for (const match of text.matchAll(regex)) {
    const word = match[group] ?? match[0]
    const base = match.index ?? 0
    const start = offset + base + match[0].indexOf(word)
    if (avoidAnySpan ? insideSpan(spans, start) : insideStringOrComment(spans, start)) continue
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
