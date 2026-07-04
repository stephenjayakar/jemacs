import type { BufferModel } from "../kernel/buffer"
import type { TextSpan } from "../modes/mode"
import {
  adjustSpansForLineNumbers,
  displayLineNumbersType,
  firstVisibleLineNumber,
  formatWithLineNumbers,
  gutterSpans,
  regionSpansWithLineNumbers,
} from "../ui/line-numbers"
import { textWithCursor } from "../ui/text-display"
import { applyTheme, type Theme } from "./theme"
import type { ThemedText } from "./themed-text"
import { visibleTextRegion, visibleTextRegionFromStart } from "./viewport"

export function visibleStyledText(
  text: string,
  point: number,
  options: {
    mark?: number | null
    markActive?: boolean
    spans?: TextSpan[]
    theme: Theme
    buffer?: BufferModel
    maxLines?: number
    showLineNumbers?: boolean
  },
  lineBudget?: number,
): ThemedText {
  const budget = options.maxLines ?? lineBudget ?? 24
  const region = visibleTextRegion(text, point, budget)
  return styledRegion(text, region, point, options)
}

export function visibleStyledTextFromStart(
  text: string,
  point: number,
  startLine: number,
  options: {
    spans?: TextSpan[]
    theme: Theme
    buffer?: BufferModel
    maxLines?: number
    showLineNumbers?: boolean
    mark?: number | null
    markActive?: boolean
    showCursor?: boolean
  },
): ThemedText {
  const budget = options.maxLines ?? 24
  const region = visibleTextRegionFromStart(text, startLine, budget)
  return styledRegion(text, region, point, options)
}

function styledRegion(
  text: string,
  region: { visible: string; visibleStart: number },
  point: number,
  options: {
    mark?: number | null
    markActive?: boolean
    spans?: TextSpan[]
    theme: Theme
    buffer?: BufferModel
    showLineNumbers?: boolean
    showCursor?: boolean
  },
): ThemedText {
  const visibleEnd = region.visibleStart + region.visible.length
  const spans = options.spans ?? []
  const mark = options.mark ?? null
  const allSpans: TextSpan[] = mark == null || mark === point
    ? spans
    : [...spans, { start: Math.min(mark, point), end: Math.max(mark, point), face: "region" }]
  const visibleSpans = allSpans
    .filter(span => span.end > region.visibleStart && span.start < visibleEnd)
    .map(span => ({
      ...span,
      start: Math.max(0, span.start - region.visibleStart),
      end: Math.min(region.visible.length, span.end - region.visibleStart),
    }))
  let visible = region.visible
  let shiftedSpans = visibleSpans
  if (options.showCursor && point >= region.visibleStart && point <= visibleEnd) {
    const cursorPos = point - region.visibleStart
    visible = textWithCursor(region.visible, cursorPos)
    if (visible.length > region.visible.length) {
      const shift = (n: number) => (n >= cursorPos ? n + 1 : n)
      shiftedSpans = visibleSpans.map(s => ({ ...s, start: shift(s.start), end: shift(s.end) }))
    }
  }
  if (!options.showLineNumbers) return applyTheme(visible, shiftedSpans, options.theme, { buffer: options.buffer })

  const firstLine = firstVisibleLineNumber(region.visibleStart, text)
  const visibleLineCount = visible.split("\n").length
  const cursorLine = text.slice(0, Math.min(point, text.length)).split("\n").length
  const format = formatWithLineNumbers(visible, firstLine, displayLineNumbersType(), cursorLine)
  const currentLineIndex = options.showCursor
    && cursorLine >= firstLine
    && cursorLine < firstLine + visibleLineCount
    ? cursorLine - firstLine
    : undefined
  const contentSpans = shiftedSpans.filter(span => span.face !== "region")
  const regionBounds = shiftedSpans.filter(span => span.face === "region")
  const regionSpans = regionBounds.length
    ? regionSpansWithLineNumbers(
      Math.min(...regionBounds.map(span => span.start)),
      Math.max(...regionBounds.map(span => span.end)),
      visible,
      format,
    )
    : []
  const displaySpans = [
    ...gutterSpans(format.text, format.prefixLen, currentLineIndex),
    ...adjustSpansForLineNumbers(contentSpans, visible, format.prefixLen),
    ...regionSpans,
  ]
  return applyTheme(format.text, displaySpans, options.theme, { buffer: options.buffer })
}
