import type { BufferModel } from "../kernel/buffer"
import { defineMode, type FontLockRange, type TextSpan } from "./mode"

const goModKeywords = new Set(["exclude", "go", "module", "replace", "require", "retract", "toolchain", "use"])
const goModKeywordRegex = /^\s*(module|go|toolchain|require|replace|exclude|retract|use)\b/gm
const goModuleVersion = /\bv\d+(?:\.\d+){1,2}(?:[-+][0-9A-Za-z.-]+)?\b/g
const goSumLine = /^(\S+)\s+(v\d+(?:\.\d+){1,2}(?:[-+][0-9A-Za-z.-]+)?(?:\/go\.mod)?)\s+(h1:\S+)$/gm

export function installGoModModes(): void {
  defineMode({
    name: "go-mod-mode",
    parent: "prog-mode",
    commentStart: "//",
    indentLine: goModIndentLine,
    fontLock: goModFontLock,
  })
  defineMode({
    name: "go-sum-mode",
    parent: "text",
    fontLock: goSumFontLock,
  })
}

export function goModIndentLine(buffer: BufferModel): void {
  const line = buffer.lineBoundsAt()
  const content = line.text.replace(/^[ \t]*/, "")
  const depth = goModParenDepthBefore(buffer.text, line.start)
  const desired = depth > 0 && !content.trimStart().startsWith(")") ? "\t" : ""
  const oldIndent = line.text.length - content.length
  const column = buffer.point - line.start
  buffer.replaceRange(line.start, line.end, desired + content)
  buffer.point = line.start + Math.max(desired.length, column + desired.length - oldIndent)
}

export function goModFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const spans: TextSpan[] = []
  const { text, offset } = fontLockSlice(buffer, range)
  spans.push(...goModProtectedSpans(text, offset))

  addGroupedMatches(text, goModKeywordRegex, "keyword", spans, offset, 1)
  addMatches(text, goModuleVersion, "constant", spans, offset)

  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

export function goSumFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const spans: TextSpan[] = []
  const { text, offset } = fontLockSlice(buffer, range)
  for (const match of text.matchAll(goSumLine)) {
    const line = match[0]
    const modulePath = match[1]!
    const version = match[2]!
    const hash = match[3]!
    const base = offset + (match.index ?? 0)
    const moduleStart = base
    const versionStart = base + line.indexOf(version, modulePath.length)
    const hashStart = base + line.lastIndexOf(hash)
    spans.push({ start: moduleStart, end: moduleStart + modulePath.length, face: "function" })
    spans.push({ start: versionStart, end: versionStart + version.length, face: "constant" })
    spans.push({ start: hashStart, end: hashStart + hash.length, face: "string" })
  }
  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

function goModProtectedSpans(text: string, offset: number): TextSpan[] {
  const spans: TextSpan[] = []
  for (let i = 0; i < text.length;) {
    if (text.startsWith("//", i)) {
      const end = lineEnd(text, i)
      spans.push({ start: offset + i, end: offset + end, face: "comment" })
      i = end
      continue
    }
    const ch = text[i]!
    if (ch === "\"" || ch === "`") {
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
    i++
  }
  return spans
}

function goModParenDepthBefore(text: string, lineStart: number): number {
  let depth = 0
  let quote: string | null = null
  let escaped = false
  for (let i = 0; i < lineStart; i++) {
    if (quote) {
      if (escaped) escaped = false
      else if (quote === "\"" && text[i] === "\\") escaped = true
      else if (text[i] === quote) quote = null
      continue
    }
    if (text.startsWith("//", i)) {
      i = lineEnd(text, i)
      continue
    }
    const ch = text[i]!
    if (ch === "\"" || ch === "`") {
      quote = ch
      continue
    }
    if (ch === "(") depth++
    else if (ch === ")") depth = Math.max(0, depth - 1)
  }
  return depth
}

function addMatches(text: string, regex: RegExp, face: TextSpan["face"], spans: TextSpan[], offset: number): void {
  for (const match of text.matchAll(regex)) {
    const start = offset + (match.index ?? 0)
    if (!insideStringOrComment(spans, start)) spans.push({ start, end: start + match[0].length, face })
  }
}

function addGroupedMatches(text: string, regex: RegExp, face: TextSpan["face"], spans: TextSpan[], offset: number, group: number): void {
  for (const match of text.matchAll(regex)) {
    const word = match[group] ?? match[0]
    if (!goModKeywords.has(word)) continue
    const base = match.index ?? 0
    const start = offset + base + match[0].indexOf(word)
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
