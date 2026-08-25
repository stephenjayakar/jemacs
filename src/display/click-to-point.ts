import { displayLineNumbersType, lineNumberPrefixLen } from "../ui/line-numbers"

/** Gutter width in cells when line numbers are shown (matches `formatWithLineNumbers`). */
export function gutterPrefixLen(startLine: number, visibleLineCount: number, currentLine = startLine): number {
  return lineNumberPrefixLen(startLine, visibleLineCount, displayLineNumbersType(), currentLine)
}

export type WindowClickState = {
  startLine: number
  gutterPrefixLen: number
  displayText?: string
  leftPadding?: number
  displayToBuffer?: (n: number) => number
  /**
   * Physical-row map, when the pane's text was hard-wrapped.
   *
   * Without it `row` is read as an offset from `startLine` in *logical* lines,
   * which is only correct while nothing wraps: one long line renders as many
   * rows, so every click below it lands too far down the buffer. Each entry
   * gives the logical line (relative to `startLine`) and the character range of
   * that line the row displays, plus the row's own left padding (`pad`).
   */
  wrappedRows?: Array<{ line: number; start: number; end: number; pad?: number }>
}

export function windowClickState(
  bufferText: string,
  startLine: number,
  maxLines: number,
  showLineNumbers: boolean,
  currentLine = startLine + 1,
): WindowClickState {
  const lines = bufferText.split("\n")
  const start = Math.max(0, Math.min(startLine, Math.max(0, lines.length - maxLines)))
  const visibleLineCount = Math.min(maxLines, Math.max(1, lines.length - start))
  const gutter = showLineNumbers ? gutterPrefixLen(start + 1, visibleLineCount, currentLine) : 0
  return { startLine: start, gutterPrefixLen: gutter, displayText: bufferText }
}

/** Map a click in the window body (cell row/col from body top-left) to a buffer point. */
export function pointFromWindowClick(
  text: string,
  state: WindowClickState,
  row: number,
  col: number,
  maxLines: number,
): number {
  const hitText = state.displayText ?? text
  const lines = hitText.split("\n")
  const wrapped = state.wrappedRows
  // A wrapped row shows a slice of its logical line, and continuation rows are
  // left-padded by the gutter width. Resolve the row through the map so the
  // column is measured against the characters actually on that row.
  const hit = wrapped?.[Math.max(0, Math.min(row, wrapped.length - 1))]
  const lineIdx = Math.max(0, Math.min(state.startLine + Math.max(0, hit ? hit.line : row), lines.length - 1))
  const lineStart = lines.slice(0, lineIdx).join("\n").length + (lineIdx > 0 ? 1 : 0)
  const line = lines[lineIdx] ?? ""
  // Continuation rows of an adaptive-wrapped line carry extra left padding.
  const visualPrefix = (hit?.pad ?? state.gutterPrefixLen) + (state.leftPadding ?? 0)
  const rowStart = Math.min(hit ? hit.start : 0, line.length)
  const rowEnd = Math.min(hit ? hit.end : line.length, line.length)
  const colInLine = Math.max(rowStart, Math.min(col - visualPrefix + rowStart, rowEnd))
  const displayPoint = lineStart + colInLine
  const point = state.displayToBuffer ? state.displayToBuffer(displayPoint) : displayPoint
  const maxPoint = state.displayToBuffer ? Number.POSITIVE_INFINITY : hitText.length
  return Math.max(0, Math.min(point, maxPoint))
}

/** Plain visible lines for hit-testing (no cursor glyph). */
export function visibleLinesForClick(
  bufferText: string,
  startLine: number,
  maxLines: number,
): string[] {
  const lines = bufferText.split("\n")
  const start = Math.max(0, Math.min(startLine, Math.max(0, lines.length - maxLines)))
  return lines.slice(start, start + maxLines)
}
