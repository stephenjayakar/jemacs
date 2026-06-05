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

export function gutterSpans(formatted: string, prefixLen: number, currentLineIndex?: number): TextSpan[] {
  const spans: TextSpan[] = []
  let offset = 0
  const lines = formatted.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const face = currentLineIndex === i ? "lineNumberCurrent" : "lineNumber"
    spans.push({ start: offset, end: offset + prefixLen, face })
    offset += line.length + 1
  }
  return spans
}

export function adjustSpansForLineNumbers(spans: TextSpan[], visible: string, prefixLen: number): TextSpan[] {
  const ls = scanLineStarts(visible)
  return spans
    .map(span => ({
      ...span,
      start: mapVisibleOffset(span.start, visible, prefixLen, ls),
      end: mapVisibleOffset(span.end, visible, prefixLen, ls),
    }))
    .filter(span => span.end > span.start)
}

export function mapVisibleOffset(
  offset: number,
  visible: string,
  prefixLen: number,
  /** Pass precomputed line starts for `visible` to skip the O(n) scan. */
  lineStarts?: readonly number[],
): number {
  const ls = lineStarts ?? scanLineStarts(visible)
  // Each line gains `prefixLen` gutter chars, so an offset on 0-indexed line L shifts by (L+1)*prefixLen.
  return Math.max(0, offset) + (lineAt(ls, offset) + 1) * prefixLen
}

export function firstVisibleLineNumber(
  visibleStart: number,
  text: string,
  /** Pass `buffer.lineStarts` when `text === buffer.text` to skip the O(n) scan. */
  lineStarts?: readonly number[],
): number {
  if (visibleStart <= 0) return 1
  return lineAt(lineStarts ?? scanLineStarts(text), visibleStart) + 1
}

function scanLineStarts(text: string): number[] {
  const ls = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) ls.push(i + 1)
  return ls
}

/** 0-indexed line containing `offset` (largest i with ls[i] <= offset). */
function lineAt(ls: readonly number[], offset: number): number {
  let lo = 0, hi = ls.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ls[mid]! <= offset) lo = mid; else hi = mid - 1
  }
  return lo
}
