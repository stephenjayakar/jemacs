import type { BufferModel } from "../kernel/buffer"
import type { TextSpan } from "../modes/mode"
import { resolveFace } from "../runtime/faces"
import {
  DOM_FRAME_LINE_HEIGHT_RATIO,
  DOM_FRAME_ROW_PX,
  effectiveFontSizePx,
} from "./dom-frame"
import { wrapRowsForContent } from "./display-wrap"

const DOM_FRAME_BODY_FONT_PX_FALLBACK = 13
import type { Theme } from "./theme"
import { styleToChunk } from "./themed-text"

export type LineWrapOptions = {
  wrapCols?: number
  gutterPrefixLen?: number
  wordWrap?: boolean
  /** Compute only this inclusive line range; omitted entries behave as 1 row. */
  fromLine?: number
  toLine?: number
  /** Display-layer lines (may differ from buffer when markup is hidden). */
  displayLines?: readonly string[]
  /** Display-layer line lengths (legacy fallback when text is unavailable). */
  displayLineLengths?: readonly number[]
}

function bodyDefaultFontPx(theme: Theme, buffer?: BufferModel): number {
  const defaultStyle = resolveFace("default", theme, buffer)
  return defaultStyle?.height != null ? defaultStyle.height / 10 : DOM_FRAME_BODY_FONT_PX_FALLBACK
}

function lineMaxFontPx(
  lineStart: number,
  lineEnd: number,
  spans: TextSpan[],
  fromSpan: number,
  theme: Theme,
  buffer: BufferModel | undefined,
  textScale: number,
  defaultPx: number,
): number {
  let maxPx = effectiveFontSizePx({ text: "" }, textScale, defaultPx) ?? defaultPx * textScale
  for (let i = fromSpan; i < spans.length; i++) {
    const span = spans[i]!
    if (span.start >= lineEnd) break
    if (span.end <= lineStart) continue
    const style = resolveFace(span.face, theme, buffer)
    const px = effectiveFontSizePx({ text: "", ...styleToChunk(style) }, textScale, defaultPx)
    if (px != null && px > maxPx) maxPx = px
  }
  return maxPx
}

function spansSortedByStart(spans: TextSpan[]): TextSpan[] {
  for (let i = 1; i < spans.length; i++) {
    const prev = spans[i - 1]!
    const cur = spans[i]!
    if (cur.start < prev.start || (cur.start === prev.start && cur.end < prev.end)) {
      return [...spans].sort((a, b) => a.start - b.start || a.end - b.end)
    }
  }
  return spans
}

/** GUI visual row cost per logical line (1.0 ≈ one `DOM_FRAME_ROW_PX` row). */
export function computeLineVisualRows(
  text: string,
  spans: TextSpan[],
  theme: Theme,
  buffer?: BufferModel,
  textScale = 1,
  wrap?: LineWrapOptions,
): number[] {
  const lines = wrap?.displayLines ?? text.split("\n")
  if (!lines.length) return []
  const fromLine = Math.max(0, Math.min(wrap?.fromLine ?? 0, lines.length - 1))
  const toLine = Math.max(fromLine, Math.min(wrap?.toLine ?? lines.length - 1, lines.length - 1))
  const defaultPx = bodyDefaultFontPx(theme, buffer)
  const rowPx = DOM_FRAME_ROW_PX * textScale
  const sortedSpans = spansSortedByStart(spans)
  const rows: number[] = new Array(lines.length)
  let offset = 0
  for (let i = 0; i < fromLine; i++) offset += lines[i]!.length + 1
  let spanCursor = 0
  while (spanCursor < sortedSpans.length && sortedSpans[spanCursor]!.end <= offset) spanCursor++
  for (let i = fromLine; i <= toLine; i++) {
    const line = lines[i]!
    const lineStart = offset
    const lineEnd = offset + line.length
    while (spanCursor < sortedSpans.length && sortedSpans[spanCursor]!.end <= lineStart) spanCursor++
    const maxPx = lineMaxFontPx(lineStart, lineEnd, sortedSpans, spanCursor, theme, buffer, textScale, defaultPx)
    let cost = (maxPx * DOM_FRAME_LINE_HEIGHT_RATIO) / rowPx
    if (wrap?.wrapCols != null) {
      const displayLine = wrap.displayLines?.[i]
      const lineForWrap = displayLine ?? wrap.displayLineLengths?.[i] ?? line.length
      cost *= wrapRowsForContent(lineForWrap, wrap.wrapCols, wrap.gutterPrefixLen ?? 0, wrap.wordWrap)
    }
    rows[i] = cost
    offset = lineEnd + 1
  }
  return rows
}

/** @deprecated Use `computeLineVisualRows`. Kept as alias for tests. */
export const computeLineVisualWeights = computeLineVisualRows

/** Terminal/char-grid visual row cost per logical line from wrapping alone.
 *  GUI hosts layer font-height costs on top via `computeLineVisualRows`; TUI
 *  still needs these wrap costs so viewport boundary checks use screen rows. */
export function computeWrappedLineRows(
  lines: readonly string[],
  wrap?: LineWrapOptions,
): number[] | undefined {
  if (wrap?.wrapCols == null) return undefined
  if (!lines.length) return []
  const fromLine = Math.max(0, Math.min(wrap.fromLine ?? 0, lines.length - 1))
  const toLine = Math.max(fromLine, Math.min(wrap.toLine ?? lines.length - 1, lines.length - 1))
  const rows: number[] = new Array(lines.length)
  for (let i = fromLine; i <= toLine; i++) {
    rows[i] = wrapRowsForContent(lines[i] ?? "", wrap.wrapCols, wrap.gutterPrefixLen ?? 0, wrap.wordWrap)
  }
  return rows
}

export function hasNonUnitVisualRows(rows: readonly number[] | undefined): boolean {
  return rows?.some(row => row != null && Math.abs(row - 1) > 1e-6) ?? false
}

export function visualRowLineRange(startLine: number, cursorLine: number, maxLines: number, lineCount: number): { fromLine: number; toLine: number } {
  const visibleStart = Math.max(0, Math.min(startLine, Math.max(0, lineCount - 1)))
  const cursor = Math.max(0, Math.min(cursorLine, Math.max(0, lineCount - 1)))
  const pad = Math.max(8, maxLines)
  const fromLine = Math.max(0, Math.min(visibleStart, cursor) - pad)
  const toLine = Math.min(Math.max(0, lineCount - 1), Math.max(visibleStart, cursor) + maxLines * 3 + pad)
  return { fromLine, toLine }
}

export function visualRowsUsed(rows: readonly number[], fromLine: number, toLine: number): number {
  let sum = 0
  for (let i = Math.max(0, fromLine); i <= toLine && i < rows.length; i++) sum += rows[i] ?? 1
  return sum
}

import { setDisplaySystem } from "../kernel/extension-points"

/** Keep `cursorLine` visible within a weighted GUI row budget. */
export function syncViewportStartLine(
  startLine: number,
  cursorLine: number,
  lineBudget: number,
  visualRows?: readonly number[],
): number {
  if (cursorLine < startLine) return cursorLine
  if (!visualRows?.length) {
    if (cursorLine >= startLine + lineBudget) return Math.max(0, cursorLine - lineBudget + 1)
    return startLine
  }
  let start = startLine
  while (start < cursorLine && visualRowsUsed(visualRows, start, cursorLine) > lineBudget) start++
  if (start > cursorLine) start = cursorLine
  return start
}

setDisplaySystem({ syncViewportStartLine })

/** How many logical lines fit in `lineBudget` GUI rows from `startLine`. */
export function visibleLineCountForBudget(
  startLine: number,
  lineBudget: number,
  totalLines: number,
  visualRows?: readonly number[],
): number {
  const remaining = Math.max(0, totalLines - startLine)
  if (!visualRows?.length || remaining === 0) return Math.min(lineBudget, remaining)
  let used = 0
  let count = 0
  for (let i = startLine; i < totalLines; i++) {
    const cost = visualRows[i] ?? 1
    if (count > 0 && used + cost > lineBudget + 1e-6) break
    used += cost
    count++
  }
  return Math.max(1, Math.min(count, remaining))
}
