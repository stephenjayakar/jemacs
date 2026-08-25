import type { BufferModel } from "../kernel/buffer"
import { defineMode, type FontLockRange, type ImenuIndexEntry, type TextSpan } from "./mode"

type XmlTag = {
  name: string;
  nameStart: number;
  nameEnd: number;
  end: number;
  closing: boolean;
  selfClosing: boolean;
}

type SpanRange = { start: number; end: number }

const entityReference = /&(?:#[0-9]+|#x[0-9A-Fa-f]+|[A-Za-z_:][A-Za-z0-9_.:-]*);/g
const voidElements = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
])

export function installXmlMode(): void {
  defineMode({
    name: "xml-mode",
    parent: "text",
    commentStart: "<!--",
    indentLine: xmlIndentLine,
    fontLock: xmlFontLock,
    imenuIndex: xmlImenuIndex,
  })
  defineMode({ name: "nxml-mode", parent: "xml-mode" })
  defineMode({ name: "sgml-mode", parent: "xml-mode" })
}

export function xmlIndentLine(buffer: BufferModel): void {
  const line = buffer.lineBoundsAt()
  const content = line.text.replace(/^\s*/, "")
  const desired = xmlDesiredIndent(buffer.text, line.start, content)
  const oldIndent = line.text.length - content.length
  const column = buffer.point - line.start
  buffer.replaceRange(line.start, line.end, " ".repeat(desired) + content)
  buffer.point = line.start + Math.max(desired, column + desired - oldIndent)
}

export function xmlFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const spans: TextSpan[] = []
  const protectedSpans: SpanRange[] = []
  const { text, offset } = fontLockSlice(buffer, range)

  for (let i = 0; i < text.length;) {
    if (text.startsWith("<!--", i)) {
      const end = delimitedEnd(text, i, "-->", 4)
      spans.push({ start: offset + i, end: offset + end, face: "comment" })
      protectedSpans.push({ start: offset + i, end: offset + end })
      i = end
      continue
    }
    if (text.startsWith("<![CDATA[", i)) {
      const end = delimitedEnd(text, i, "]]>", 9)
      spans.push({ start: offset + i, end: offset + end, face: "string" })
      protectedSpans.push({ start: offset + i, end: offset + end })
      i = end
      continue
    }
    if (text.startsWith("<?", i)) {
      const end = processingInstructionEnd(text, i)
      spans.push({ start: offset + i, end: offset + end, face: "keyword" })
      protectedSpans.push({ start: offset + i, end: offset + end })
      addAttributeSpans(text, i + 2, processingInstructionContentEnd(text, end), offset, spans)
      i = end
      continue
    }
    if (isDoctypeStart(text, i)) {
      const end = markupEnd(text, i)
      spans.push({ start: offset + i, end: offset + end, face: "keyword" })
      protectedSpans.push({ start: offset + i, end: offset + end })
      i = end
      continue
    }
    if (text[i] === "<") {
      const tag = parseXmlTag(text, i)
      if (tag) {
        spans.push({ start: offset + tag.nameStart, end: offset + tag.nameEnd, face: "function" })
        if (!tag.closing) addAttributeSpans(text, tag.nameEnd, markupContentEnd(text, tag.end), offset, spans)
        i = tag.end
        continue
      }
    }
    i++
  }

  addEntityReferences(text, offset, spans, protectedSpans)
  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

export function xmlImenuIndex(buffer: BufferModel): ImenuIndexEntry[] {
  const entries: ImenuIndexEntry[] = []
  let depth = 0
  for (let i = 0; i < buffer.text.length;) {
    const tag = nextXmlTag(buffer.text, i)
    if (!tag) break
    i = tag.end

    if (tag.closing) {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth === 0) entries.push({ name: tag.name, point: tag.nameStart })
    if (!tag.selfClosing && !isVoidElement(tag.name)) depth++
  }
  return entries
}

function xmlDesiredIndent(text: string, lineStart: number, content: string): number {
  let depth = 0
  for (let i = 0; i < lineStart;) {
    const tag = nextXmlTag(text, i, lineStart)
    if (!tag) break
    i = tag.end

    if (tag.closing) depth = Math.max(0, depth - 1)
    else if (!tag.selfClosing && !isVoidElement(tag.name)) depth++
  }
  if (/^<\s*\//.test(content)) depth = Math.max(0, depth - 1)
  return depth * 2
}

function nextXmlTag(text: string, start: number, limit = text.length): XmlTag | null {
  let i = start
  while (i < limit) {
    const lt = text.indexOf("<", i)
    if (lt === -1 || lt >= limit) return null
    if (text.startsWith("<!--", lt)) {
      i = delimitedEnd(text, lt, "-->", 4)
      continue
    }
    if (text.startsWith("<![CDATA[", lt)) {
      i = delimitedEnd(text, lt, "]]>", 9)
      continue
    }
    if (text.startsWith("<?", lt)) {
      i = processingInstructionEnd(text, lt)
      continue
    }
    if (text.startsWith("<!", lt)) {
      i = markupEnd(text, lt)
      continue
    }
    const tag = parseXmlTag(text, lt)
    if (tag) return tag
    i = lt + 1
  }
  return null
}

function parseXmlTag(text: string, start: number): XmlTag | null {
  if (text[start] !== "<") return null
  let nameStart = start + 1
  const closing = text[nameStart] === "/"
  if (closing) nameStart++
  while (nameStart < text.length && /\s/.test(text[nameStart]!)) nameStart++
  if (!isNameStart(text[nameStart])) return null
  const nameEnd = readNameEnd(text, nameStart)
  const end = markupEnd(text, start)
  return {
    name: text.slice(nameStart, nameEnd),
    nameStart,
    nameEnd,
    end,
    closing,
    selfClosing: isSelfClosingTag(text, end),
  }
}

function addAttributeSpans(text: string, start: number, end: number, offset: number, spans: TextSpan[]): void {
  let i = Math.max(0, start)
  const limit = Math.max(i, Math.min(end, text.length))
  while (i < limit) {
    const ch = text[i]!
    if (ch === "\"" || ch === "'") {
      i = quotedEnd(text, i, limit)
      continue
    }
    if (!isNameStart(ch)) {
      i++
      continue
    }

    const nameStart = i
    const nameEnd = readNameEnd(text, nameStart)
    let valueStart = nameEnd
    while (valueStart < limit && /\s/.test(text[valueStart]!)) valueStart++
    if (text[valueStart] !== "=") {
      i = nameEnd
      continue
    }

    spans.push({ start: offset + nameStart, end: offset + nameEnd, face: "type" })
    valueStart++
    while (valueStart < limit && /\s/.test(text[valueStart]!)) valueStart++

    const quote = text[valueStart]
    if (quote === "\"" || quote === "'") {
      const valueEnd = quotedEnd(text, valueStart, limit)
      spans.push({ start: offset + valueStart, end: offset + valueEnd, face: "string" })
      i = valueEnd
    } else {
      const valueEnd = unquotedValueEnd(text, valueStart, limit)
      if (valueStart < valueEnd) spans.push({ start: offset + valueStart, end: offset + valueEnd, face: "string" })
      i = valueEnd
    }
  }
}

function addEntityReferences(text: string, offset: number, spans: TextSpan[], protectedSpans: SpanRange[]): void {
  for (const match of text.matchAll(entityReference)) {
    const start = offset + (match.index ?? 0)
    if (!insideSpan(protectedSpans, start)) spans.push({ start, end: start + match[0].length, face: "constant" })
  }
}

function markupEnd(text: string, start: number): number {
  let quote: string | null = null
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      if (ch === quote) quote = null
      continue
    }
    if (ch === "\"" || ch === "'") {
      quote = ch
      continue
    }
    if (ch === ">") return i + 1
  }
  return text.length
}

function delimitedEnd(text: string, start: number, delimiter: string, bodyStartOffset: number): number {
  const close = text.indexOf(delimiter, start + bodyStartOffset)
  return close === -1 ? text.length : close + delimiter.length
}

function processingInstructionEnd(text: string, start: number): number {
  const close = text.indexOf("?>", start + 2)
  return close === -1 ? markupEnd(text, start) : close + 2
}

function processingInstructionContentEnd(text: string, end: number): number {
  return text.slice(end - 2, end) === "?>" ? end - 2 : markupContentEnd(text, end)
}

function markupContentEnd(text: string, end: number): number {
  return text[end - 1] === ">" ? end - 1 : end
}

function quotedEnd(text: string, start: number, limit: number): number {
  const quote = text[start]
  let end = start + 1
  while (end < limit) {
    if (text[end] === quote) return end + 1
    end++
  }
  return end
}

function unquotedValueEnd(text: string, start: number, limit: number): number {
  let end = start
  while (end < limit && !/[\s/>?]/.test(text[end]!)) end++
  return end
}

function isSelfClosingTag(text: string, end: number): boolean {
  let i = Math.min(text.length, end) - 1
  if (text[i] === ">") i--
  while (i >= 0 && /\s/.test(text[i]!)) i--
  return text[i] === "/"
}

function isDoctypeStart(text: string, start: number): boolean {
  return text.slice(start, start + 9).toUpperCase() === "<!DOCTYPE" && !isNameChar(text[start + 9])
}

function isVoidElement(name: string): boolean {
  return voidElements.has(name.toLowerCase())
}

function readNameEnd(text: string, start: number): number {
  let end = start + 1
  while (end < text.length && isNameChar(text[end])) end++
  return end
}

function isNameStart(ch: string | undefined): boolean {
  return ch != null && /[A-Za-z_:]/.test(ch)
}

function isNameChar(ch: string | undefined): boolean {
  return ch != null && /[A-Za-z0-9_.:-]/.test(ch)
}

function insideSpan(spans: SpanRange[], point: number): boolean {
  return spans.some(span => point >= span.start && point < span.end)
}

function fontLockSlice(buffer: BufferModel, range?: FontLockRange): { text: string; offset: number } {
  if (!range) return { text: buffer.text, offset: 0 }
  const startLine = Math.max(0, Math.min(range.startLine, buffer.lineCount - 1))
  const endLine = Math.max(startLine, Math.min(range.endLine, buffer.lineCount))
  const start = buffer.lineStarts[startLine] ?? 0
  const end = endLine < buffer.lineCount ? buffer.lineStarts[endLine]! : buffer.text.length
  return { text: buffer.text.slice(start, end), offset: start }
}
