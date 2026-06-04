import type { TextSpan } from "../modes/mode"

export type LineNumberFormat = {
  text: string
  prefixLen: number
  firstLine: number
}

const GUTTER_SEPARATOR = "  "

export function formatWithLineNumbers(visible: string, firstLine: number): LineNumberFormat {
  const lines = visible.split("\n")
  const width = Math.max(1, String(firstLine + Math.max(0, lines.length - 1)).length)
  const prefixLen = width + GUTTER_SEPARATOR.length
  const text = lines
    .map((line, index) => `${String(firstLine + index).padStart(width, " ")}${GUTTER_SEPARATOR}${line}`)
    .join("\n")
  return { text, prefixLen, firstLine }
}

/** Apply region highlight only to buffer text, not the line-number gutter on each line. */
export function regionSpansWithLineNumbers(
  regionStart: number,
  regionEnd: number,
  visible: string,
  format: LineNumberFormat,
): TextSpan[] {
  if (regionStart >= regionEnd) return []
  const spans: TextSpan[] = []
  const lines = visible.split("\n")
  let pos = 0
  let formatted = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const lineEnd = pos + line.length
    const overlapStart = Math.max(regionStart, pos)
    const overlapEnd = Math.min(regionEnd, lineEnd)
    if (overlapStart < overlapEnd) {
      const contentStart = formatted + format.prefixLen
      spans.push({
        start: contentStart + (overlapStart - pos),
        end: contentStart + (overlapEnd - pos),
        face: "region",
      })
    }
    formatted += format.prefixLen + line.length + (i < lines.length - 1 ? 1 : 0)
    pos = lineEnd + 1
  }
  return spans
}

export function gutterSpans(formatted: string, prefixLen: number): TextSpan[] {
  const spans: TextSpan[] = []
  let offset = 0
  for (const line of formatted.split("\n")) {
    spans.push({ start: offset, end: offset + prefixLen, face: "lineNumber" })
    offset += line.length + 1
  }
  return spans
}

export function adjustSpansForLineNumbers(spans: TextSpan[], visible: string, prefixLen: number): TextSpan[] {
  return spans
    .map(span => ({
      ...span,
      start: mapVisibleOffset(span.start, visible, prefixLen),
      end: mapVisibleOffset(span.end, visible, prefixLen),
    }))
    .filter(span => span.end > span.start)
}

export function mapVisibleOffset(offset: number, visible: string, prefixLen: number): number {
  const lines = visible.split("\n")
  let pos = 0
  let formatted = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const lineEnd = pos + line.length
    if (offset <= lineEnd || i === lines.length - 1) {
      return formatted + prefixLen + Math.max(0, offset - pos)
    }
    formatted += prefixLen + line.length + 1
    pos = lineEnd + 1
  }
  return formatted
}

export function firstVisibleLineNumber(visibleStart: number, text: string): number {
  if (visibleStart <= 0) return 1
  return text.slice(0, visibleStart).split("\n").length
}
