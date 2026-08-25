import type { BufferModel } from "../kernel/buffer"
import { defineMode, type FontLockRange, type ImenuIndexEntry, type TextSpan } from "./mode"

type Line = { text: string; start: number; end: number }

const makefileDirectives = new Set([
  "define", "else", "endef", "endif", "export", "ifdef", "ifeq", "ifndef", "ifneq", "include", "override", "sinclude", "unexport", "vpath",
])

const directiveRegex = /^(-?include|sinclude|ifeq|ifneq|ifdef|ifndef|else|endif|define|endef|override|export|unexport|vpath)\b/
const variableAssignmentRegex = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*(:=|\?=|\+=|=)/
const targetRegex = /^([^#\s:=][^#:=]*?)\s*:(?!=)/
const variableReferenceRegex = /\$\([^)]+\)|\$\{[^}]+}/g

export function installMakefileMode(): void {
  defineMode({
    name: "makefile-mode",
    parent: "prog-mode",
    commentStart: "#",
    indentLine: makefileIndentLine,
    fontLock: makefileFontLock,
    imenuIndex: makefileImenuIndex,
  })
  defineMode({ name: "makefile-gmake-mode", parent: "makefile-mode" })
  defineMode({ name: "makefile-bsdmake-mode", parent: "makefile-mode" })
}

export function makefileIndentLine(buffer: BufferModel): void {
  const line = buffer.lineBoundsAt()
  const desired = makefileShouldIndentAsRecipe(buffer.text, line.start) ? "\t" : ""
  const content = line.text.replace(/^[ \t]*/, "")
  const column = buffer.point - line.start
  const oldIndent = line.text.length - content.length
  buffer.replaceRange(line.start, line.end, desired + content)
  buffer.point = line.start + Math.max(desired.length, column + desired.length - oldIndent)
}

export function makefileFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const spans: TextSpan[] = []
  const { text, offset } = fontLockSlice(buffer, range)
  for (const line of textLines(text)) {
    const commentAt = makefileCommentStart(line.text)
    const contentEnd = commentAt === -1 ? line.text.length : commentAt
    const content = line.text.slice(0, contentEnd)
    const absoluteLineStart = offset + line.start
    if (commentAt !== -1) spans.push({ start: absoluteLineStart + commentAt, end: offset + line.end, face: "comment" })

    addVariableReferenceSpans(content, absoluteLineStart, spans)
    if (content.startsWith("\t")) continue

    const trimmedStart = firstNonWhitespace(content, 0)
    if (trimmedStart === -1) continue
    const topLevel = content.slice(trimmedStart)

    const directive = topLevel.match(directiveRegex)
    if (directive && makefileDirectives.has(directive[1]!.replace(/^-/, ""))) {
      spans.push({ start: absoluteLineStart + trimmedStart, end: absoluteLineStart + trimmedStart + directive[1]!.length, face: "keyword" })
    }

    const assignment = topLevel.match(variableAssignmentRegex)
    if (assignment) {
      const name = assignment[1]!
      const operator = assignment[2]!
      const nameStart = absoluteLineStart + trimmedStart
      const operatorStart = absoluteLineStart + trimmedStart + topLevel.indexOf(operator)
      spans.push({ start: nameStart, end: nameStart + name.length, face: "constant" })
      spans.push({ start: operatorStart, end: operatorStart + operator.length, face: "keyword" })
      continue
    }

    const target = topLevel.match(targetRegex)
    if (target) {
      const name = target[1]!.trimEnd()
      if (name) spans.push({ start: absoluteLineStart + trimmedStart, end: absoluteLineStart + trimmedStart + name.length, face: "function" })
    }
  }
  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

export function makefileImenuIndex(buffer: BufferModel): ImenuIndexEntry[] {
  const entries: ImenuIndexEntry[] = []
  for (const line of textLines(buffer.text)) {
    if (line.text.startsWith("\t")) continue
    const commentAt = makefileCommentStart(line.text)
    const content = line.text.slice(0, commentAt === -1 ? line.text.length : commentAt)
    const trimmedStart = firstNonWhitespace(content, 0)
    if (trimmedStart === -1) continue
    const topLevel = content.slice(trimmedStart)
    if (variableAssignmentRegex.test(topLevel)) continue
    const target = topLevel.match(targetRegex)
    if (!target) continue
    const name = target[1]!.trimEnd()
    if (name) entries.push({ name, point: line.start + trimmedStart })
  }
  return entries
}

function makefileShouldIndentAsRecipe(text: string, lineStart: number): boolean {
  const previous = previousLine(text, lineStart)
  if (!previous) return false
  if (previous.text.startsWith("\t")) return true
  const commentAt = makefileCommentStart(previous.text)
  const content = previous.text.slice(0, commentAt === -1 ? previous.text.length : commentAt).trim()
  if (!content || variableAssignmentRegex.test(content) || directiveRegex.test(content)) return false
  return targetRegex.test(content)
}

function addVariableReferenceSpans(content: string, offset: number, spans: TextSpan[]): void {
  for (const match of content.matchAll(variableReferenceRegex)) {
    const start = offset + (match.index ?? 0)
    spans.push({ start, end: start + match[0].length, face: "builtin" })
  }
}

function makefileCommentStart(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "#" && text[i - 1] !== "\\") return i
  }
  return -1
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
