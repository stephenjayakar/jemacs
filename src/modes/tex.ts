import type { BufferModel } from "../kernel/buffer"
import { defineMode, type FontLockRange, type ImenuIndexEntry, type TextSpan } from "./mode"

type Line = { text: string; start: number; end: number }

const texCommand = /\\(?:[A-Za-z@]+|[^A-Za-z@\s\\])/g
const texSpecial = /\\\\|&/g
const latexEnvironmentCommand = /\\(begin|end)\s*\{([^{}\n]+)\}/g
const latexSectionCommand = /\\(subsubsection|subsection|paragraph|section|chapter|part)\*?(?:\s*\[[^\]\n]*\])?\s*\{([^{}\n]*)\}/g
const latexClassPackageCommand = /\\(?:documentclass|usepackage)(?:\s*\[[^\]\n]*\])?\s*\{([^{}\n]+)\}/g
const latexReferenceCommand = /\\(?:label|ref|cite)\s*\{([^{}\n]+)\}/g
const bibtexEntryType = /@[A-Za-z]+/g
const bibtexEntry = /@[A-Za-z]+\s*[\({]\s*([^,\s]+)\s*,/g
const bibtexField = /(^|[,{\n])([ \t]*)([A-Za-z][A-Za-z0-9_-]*)\s*=/g

export function installTexModes(): void {
  defineMode({
    name: "tex-mode",
    parent: "text",
    commentStart: "%",
    indentLine: texIndentLine,
    fontLock: texFontLock,
  })
  defineMode({
    name: "latex-mode",
    parent: "tex-mode",
    commentStart: "%",
    indentLine: latexIndentLine,
    fontLock: latexFontLock,
    imenuIndex: latexImenuIndex,
  })
  defineMode({ name: "plain-tex-mode", parent: "tex-mode", commentStart: "%" })
  defineMode({
    name: "bibtex-mode",
    parent: "text",
    commentStart: "%",
    indentLine: texIndentLine,
    fontLock: bibtexFontLock,
    imenuIndex: bibtexImenuIndex,
  })
}

export function texIndentLine(_buffer: BufferModel): void {
  // TeX indentation is intentionally conservative here.
}

export function latexIndentLine(buffer: BufferModel): void {
  const line = buffer.lineBoundsAt()
  const content = line.text.replace(/^[ \t]*/, "")
  const desired = latexDesiredIndent(buffer.text, line.start, content)
  if (desired == null) return

  const oldIndent = line.text.length - content.length
  const column = buffer.point - line.start
  buffer.replaceRange(line.start, line.end, " ".repeat(desired) + content)
  buffer.point = line.start + Math.max(desired, column + desired - oldIndent)
}

export function texFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const spans: TextSpan[] = []
  const { text, offset } = fontLockSlice(buffer, range)
  spans.push(...texProtectedSpans(text, offset))

  addMatches(text, texCommand, "keyword", spans, offset)
  addTexSpecialSpans(text, offset, spans)
  addBraceSpans(text, offset, spans)

  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

export function latexFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const spans = texFontLock(buffer, range)
  const { text, offset } = fontLockSlice(buffer, range)

  addGroupedMatches(text, latexEnvironmentCommand, "type", spans, offset, 2)
  addGroupedMatches(text, latexSectionCommand, "function", spans, offset, 2)
  addGroupedMatches(text, latexClassPackageCommand, "string", spans, offset, 1)
  addGroupedMatches(text, latexReferenceCommand, "constant", spans, offset, 1)

  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

export function latexImenuIndex(buffer: BufferModel): ImenuIndexEntry[] {
  const entries: ImenuIndexEntry[] = []
  const protectedSpans = texProtectedSpans(buffer.text, 0)
  for (const match of buffer.text.matchAll(latexSectionCommand)) {
    const title = match[2] ?? ""
    const point = match.index ?? 0
    if (insideStringOrComment(protectedSpans, point)) continue
    entries.push({ name: title, point })
  }
  return entries
}

export function bibtexFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const spans: TextSpan[] = []
  const { text, offset } = fontLockSlice(buffer, range)
  spans.push(...bibtexProtectedSpans(text, offset))

  addMatches(text, bibtexEntryType, "keyword", spans, offset)
  addGroupedMatches(text, bibtexEntry, "constant", spans, offset, 1)
  addGroupedMatches(text, bibtexField, "type", spans, offset, 3)

  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

export function bibtexImenuIndex(buffer: BufferModel): ImenuIndexEntry[] {
  const entries: ImenuIndexEntry[] = []
  const protectedSpans = bibtexProtectedSpans(buffer.text, 0)
  for (const match of buffer.text.matchAll(bibtexEntry)) {
    const key = match[1]
    if (!key) continue
    const point = groupedStart(match, 1)
    if (insideStringOrComment(protectedSpans, point)) continue
    entries.push({ name: key, point })
  }
  return entries
}

function latexDesiredIndent(text: string, lineStart: number, content: string): number | null {
  const depth = latexEnvironmentDepthBefore(text, lineStart)
  const closing = /^\\end\s*\{[^{}\n]+}/.test(content)
  if (depth === 0 && !closing) return null
  return Math.max(0, depth - (closing ? 1 : 0)) * 2
}

function latexEnvironmentDepthBefore(text: string, lineStart: number): number {
  let depth = 0
  for (const line of textLines(text.slice(0, lineStart))) {
    const content = line.text.slice(0, texCommentStart(line.text))
    for (const match of content.matchAll(latexEnvironmentCommand)) {
      if (match[1] === "begin") depth++
      else depth = Math.max(0, depth - 1)
    }
  }
  return depth
}

function texProtectedSpans(text: string, offset: number): TextSpan[] {
  const spans: TextSpan[] = []
  for (let i = 0; i < text.length;) {
    if (text[i] === "%" && !isEscaped(text, i)) {
      const end = lineEnd(text, i)
      spans.push({ start: offset + i, end: offset + end, face: "comment" })
      i = end
      continue
    }
    if (text.startsWith("$$", i) && !isEscaped(text, i)) {
      const end = findDelimitedEnd(text, i + 2, "$$")
      spans.push({ start: offset + i, end: offset + end, face: "string" })
      i = end
      continue
    }
    if (text[i] === "$" && !isEscaped(text, i)) {
      const end = findDelimitedEnd(text, i + 1, "$")
      spans.push({ start: offset + i, end: offset + end, face: "string" })
      i = end
      continue
    }
    i++
  }
  return spans
}

function bibtexProtectedSpans(text: string, offset: number): TextSpan[] {
  const spans: TextSpan[] = []
  for (let i = 0; i < text.length;) {
    if (text[i] === "%" && !isEscaped(text, i)) {
      const end = lineEnd(text, i)
      spans.push({ start: offset + i, end: offset + end, face: "comment" })
      i = end
      continue
    }
    if (text[i] === "=") {
      const valueStart = firstNonWhitespace(text, i + 1)
      if (valueStart !== -1 && text[valueStart] === "\"") {
        const end = findQuotedEnd(text, valueStart)
        spans.push({ start: offset + valueStart, end: offset + end, face: "string" })
        i = end
        continue
      }
      if (valueStart !== -1 && text[valueStart] === "{") {
        const end = findBracedEnd(text, valueStart)
        spans.push({ start: offset + valueStart, end: offset + end, face: "string" })
        i = end
        continue
      }
    }
    i++
  }
  return spans
}

function addTexSpecialSpans(text: string, offset: number, spans: TextSpan[]): void {
  for (const match of text.matchAll(texSpecial)) {
    const localStart = match.index ?? 0
    if (match[0] === "&" && isEscaped(text, localStart)) continue
    const start = offset + localStart
    if (!insideStringOrComment(spans, start)) spans.push({ start, end: start + match[0].length, face: "builtin" })
  }
}

function addBraceSpans(text: string, offset: number, spans: TextSpan[]): void {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch !== "{" && ch !== "}") continue
    const start = offset + i
    if (!insideStringOrComment(spans, start)) spans.push({ start, end: start + 1, face: "type" })
  }
}

function addMatches(text: string, regex: RegExp, face: TextSpan["face"], spans: TextSpan[], offset: number): void {
  for (const match of text.matchAll(regex)) {
    const start = offset + (match.index ?? 0)
    if (!insideStringOrComment(spans, start)) spans.push({ start, end: start + match[0].length, face })
  }
}

function addGroupedMatches(text: string, regex: RegExp, face: TextSpan["face"], spans: TextSpan[], offset: number, group: number): void {
  for (const match of text.matchAll(regex)) {
    const word = match[group]
    if (!word) continue
    const start = offset + groupedStart(match, group)
    if (!insideStringOrComment(spans, start)) spans.push({ start, end: start + word.length, face })
  }
}

function groupedStart(match: RegExpMatchArray, group: number): number {
  const word = match[group] ?? match[0]
  return (match.index ?? 0) + match[0].lastIndexOf(word)
}

function findDelimitedEnd(text: string, start: number, delimiter: "$" | "$$"): number {
  for (let i = start; i < text.length;) {
    const next = text.indexOf(delimiter, i)
    if (next === -1) return text.length
    if (!isEscaped(text, next)) return next + delimiter.length
    i = next + delimiter.length
  }
  return text.length
}

function findQuotedEnd(text: string, start: number): number {
  let i = start + 1
  while (i < text.length) {
    if (text[i] === "\\") i += 2
    else if (text[i] === "\"") return i + 1
    else i++
  }
  return text.length
}

function findBracedEnd(text: string, start: number): number {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === "{" && !isEscaped(text, i)) depth++
    else if (ch === "}" && !isEscaped(text, i)) {
      depth--
      if (depth <= 0) return i + 1
    }
  }
  return text.length
}

function texCommentStart(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "%" && !isEscaped(text, i)) return i
  }
  return text.length
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) backslashes++
  return backslashes % 2 === 1
}

function firstNonWhitespace(text: string, start: number): number {
  for (let i = start; i < text.length; i++) if (!/\s/.test(text[i]!)) return i
  return -1
}

function insideStringOrComment(spans: TextSpan[], point: number): boolean {
  return spans.some(span => point >= span.start && point < span.end && (span.face === "string" || span.face === "comment"))
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
