import type { BufferModel } from "../kernel/buffer"
import { defineMode, type FontLockRange, type ImenuIndexEntry, type TextSpan } from "./mode"

type Line = { text: string; start: number; end: number }

const dockerfileInstructions = new Set([
  "ADD", "ARG", "CMD", "COPY", "ENTRYPOINT", "ENV", "EXPOSE", "FROM", "HEALTHCHECK", "LABEL", "MAINTAINER", "ONBUILD", "RUN", "SHELL", "STOPSIGNAL", "USER", "VOLUME", "WORKDIR",
])
const variableReference = /\$\{[A-Za-z_][A-Za-z0-9_]*}/g

export function installDockerfileMode(): void {
  defineMode({
    name: "dockerfile-mode",
    parent: "prog-mode",
    commentStart: "#",
    indentLine: dockerfileIndentLine,
    fontLock: dockerfileFontLock,
    imenuIndex: dockerfileImenuIndex,
  })
}

export function dockerfileIndentLine(buffer: BufferModel): void {
  const line = buffer.lineBoundsAt()
  const content = line.text.replace(/^[ \t]*/, "")
  const desired = dockerfileDesiredIndent(buffer.text, line.start, content)
  const oldIndent = line.text.length - content.length
  const column = buffer.point - line.start
  buffer.replaceRange(line.start, line.end, " ".repeat(desired) + content)
  buffer.point = line.start + Math.max(desired, column + desired - oldIndent)
}

export function dockerfileFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const spans: TextSpan[] = []
  const { text, offset } = fontLockSlice(buffer, range)
  spans.push(...dockerfileProtectedSpans(text, offset))

  for (const line of textLines(text)) {
    const lineStart = offset + line.start
    addInstructionSpan(line.text, lineStart, spans)
    addLineContinuationSpan(line.text, lineStart, spans)
  }
  addMatches(text, variableReference, "builtin", spans, offset)

  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

export function dockerfileImenuIndex(buffer: BufferModel): ImenuIndexEntry[] {
  const entries: ImenuIndexEntry[] = []
  for (const line of textLines(buffer.text)) {
    const trimmedStart = firstNonWhitespace(line.text, 0)
    if (trimmedStart === -1 || line.text[trimmedStart] === "#") continue
    const content = line.text.slice(trimmedStart)
    const match = content.match(/^FROM\s+(?:--[^\s=]+(?:=\S+)?\s+)*\S+\s+AS\s+([A-Za-z0-9_.-]+)\b/i)
    const name = match?.[1]
    if (!name) continue
    entries.push({ name, point: line.start + trimmedStart + match[0].lastIndexOf(name) })
  }
  return entries
}

function dockerfileDesiredIndent(text: string, lineStart: number, content: string): number {
  const trimmed = content.trimStart()
  if (!trimmed || trimmed.startsWith("#") || instructionAtLineStart(trimmed)) return 0
  const previous = previousLine(text, lineStart)
  return previous && lineContinuationIndex(previous.text) !== -1 ? 4 : 0
}

function dockerfileProtectedSpans(text: string, offset: number): TextSpan[] {
  const spans: TextSpan[] = []
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

function addInstructionSpan(text: string, offset: number, spans: TextSpan[]): void {
  const trimmedStart = firstNonWhitespace(text, 0)
  if (trimmedStart === -1) return
  const match = text.slice(trimmedStart).match(/^([A-Za-z][A-Za-z0-9_-]*)\b/)
  const word = match?.[1]
  if (!word || !dockerfileInstructions.has(word.toUpperCase())) return
  const start = offset + trimmedStart
  if (!insideStringOrComment(spans, start)) spans.push({ start, end: start + word.length, face: "keyword" })
}

function addLineContinuationSpan(text: string, offset: number, spans: TextSpan[]): void {
  const continuation = lineContinuationIndex(text)
  if (continuation === -1) return
  const start = offset + continuation
  if (!insideStringOrComment(spans, start)) spans.push({ start, end: start + 1, face: "keyword" })
}

function addMatches(text: string, regex: RegExp, face: TextSpan["face"], spans: TextSpan[], offset: number): void {
  for (const match of text.matchAll(regex)) {
    const start = offset + (match.index ?? 0)
    if (!insideStringOrComment(spans, start)) spans.push({ start, end: start + match[0].length, face })
  }
}

function instructionAtLineStart(text: string): boolean {
  const match = text.match(/^([A-Za-z][A-Za-z0-9_-]*)\b/)
  return !!match?.[1] && dockerfileInstructions.has(match[1].toUpperCase())
}

function lineContinuationIndex(text: string): number {
  let quote: string | null = null
  let escaped = false
  let lastUnprotected = -1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "#") break
    if (ch === "\"" || ch === "'" || ch === "`") {
      quote = ch
      continue
    }
    if (!/\s/.test(ch)) lastUnprotected = i
  }
  return lastUnprotected !== -1 && text[lastUnprotected] === "\\" ? lastUnprotected : -1
}

function previousLine(text: string, lineStart: number): Line | null {
  if (lineStart <= 0) return null
  const end = lineStart - 1
  const start = end <= 0 ? 0 : text.lastIndexOf("\n", end - 1) + 1
  return { text: text.slice(start, end), start, end }
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
