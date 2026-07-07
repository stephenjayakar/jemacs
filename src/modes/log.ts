import type { BufferModel } from "../kernel/buffer"
import { defineMode, type FontLockRange, type TextSpan } from "./mode"

type Line = { text: string; start: number; end: number }
type FontLockBounds = { start: number; end: number }

const topHeaderRegex = /^\s*([A-Z][A-Za-z0-9-]*:)(?=\s|$)/
const logViewCommitRegex = /^(commit)\s+([0-9A-Fa-f]{7,40})\b/
const logViewHeaderRegex = /^((?:Author|Date):)/
const shortShaRegex = /^([0-9A-Fa-f]{7,12})(?=\s|$)/
const changeLogHeadingRegex = /^\d{4}-\d{2}-\d{2}\s+\S.*$/
const changeLogFileEntryRegex = /^\t\*\s+([^\s(:][^(:]*?)(?=\s*(?:\(|:))/
const parenthesizedFunctionRegex = /\(([^()\n]+)\)/g

export function installLogModes(): void {
  defineMode({
    name: "log-edit-mode",
    parent: "text",
    commentStart: "#",
    fontLock: logEditFontLock,
  })
  defineMode({
    name: "log-view-mode",
    parent: "text",
    fontLock: logViewFontLock,
  })
  defineMode({
    name: "change-log-mode",
    parent: "text",
    fontLock: changeLogFontLock,
  })
}

export function logEditFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const spans: TextSpan[] = []
  const bounds = fontLockBounds(buffer, range)
  const lines = textLines(buffer.text)

  addLogEditHeaderSpans(lines, spans, bounds)
  addLogEditSummaryWarning(lines, spans, bounds)

  for (const line of lines) {
    if (!lineIntersects(line, bounds)) continue
    const commentStart = line.text.search(/\S/)
    if (commentStart !== -1 && line.text[commentStart] === "#") addSpan(spans, line.start + commentStart, line.end, "comment", bounds)
  }

  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

export function logViewFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const spans: TextSpan[] = []
  const bounds = fontLockBounds(buffer, range)
  for (const line of textLines(buffer.text)) {
    if (!lineIntersects(line, bounds)) continue

    const commit = line.text.match(logViewCommitRegex)
    if (commit) {
      addGroupSpan(line, commit, 1, "keyword", spans, bounds)
      addGroupSpan(line, commit, 2, "constant", spans, bounds)
      continue
    }

    const header = line.text.match(logViewHeaderRegex)
    if (header) {
      addGroupSpan(line, header, 1, "keyword", spans, bounds)
      continue
    }

    const shortSha = line.text.match(shortShaRegex)
    if (shortSha) addGroupSpan(line, shortSha, 1, "constant", spans, bounds)
  }
  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

export function changeLogFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const spans: TextSpan[] = []
  const bounds = fontLockBounds(buffer, range)
  for (const line of textLines(buffer.text)) {
    if (!lineIntersects(line, bounds)) continue

    if (changeLogHeadingRegex.test(line.text)) addSpan(spans, line.start, line.end, "type", bounds)

    const fileEntry = line.text.match(changeLogFileEntryRegex)
    if (fileEntry) addGroupSpan(line, fileEntry, 1, "constant", spans, bounds)

    addChangeLogFunctionSpans(line, spans, bounds)
  }
  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

function addLogEditHeaderSpans(lines: Line[], spans: TextSpan[], bounds: FontLockBounds): void {
  for (const line of lines) {
    const trimmed = line.text.trim()
    if (!trimmed || line.text.trimStart().startsWith("#")) continue

    const header = line.text.match(topHeaderRegex)
    if (!header) return
    addGroupSpan(line, header, 1, "keyword", spans, bounds)
  }
}

function addLogEditSummaryWarning(lines: Line[], spans: TextSpan[], bounds: FontLockBounds): void {
  let inTopHeaders = true
  for (const line of lines) {
    if (!line.text.trim() || line.text.trimStart().startsWith("#")) continue
    const header = inTopHeaders ? line.text.match(topHeaderRegex) : null
    if (header) {
      if (header[1] === "Summary:" && line.text.length > 50) {
        addSpan(spans, line.start + 50, line.end, "warning", bounds)
        return
      }
      continue
    }
    inTopHeaders = false
    if (line.text.length > 50) addSpan(spans, line.start + 50, line.end, "warning", bounds)
    return
  }
}

function addChangeLogFunctionSpans(line: Line, spans: TextSpan[], bounds: FontLockBounds): void {
  parenthesizedFunctionRegex.lastIndex = 0
  for (const match of line.text.matchAll(parenthesizedFunctionRegex)) {
    const names = match[1] ?? ""
    const base = (match.index ?? 0) + match[0].indexOf(names)
    addSpan(spans, line.start + base, line.start + base + names.length, "function", bounds)
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

function lineIntersects(line: Line, bounds: FontLockBounds): boolean {
  return line.end >= bounds.start && line.start < bounds.end
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
