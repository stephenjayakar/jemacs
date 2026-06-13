/** Gutter width in cells when line numbers are shown (matches `formatWithLineNumbers`). */
export function gutterPrefixLen(startLine: number, visibleLineCount: number): number {
  const width = Math.max(1, String(startLine + Math.max(0, visibleLineCount - 1)).length)
  return width + 2
}

export type WindowClickState = {
  startLine: number
  gutterPrefixLen: number
  displayText?: string
  leftPadding?: number
  displayToBuffer?: (n: number) => number
}

export function windowClickState(
  bufferText: string,
  startLine: number,
  maxLines: number,
  showLineNumbers: boolean,
): WindowClickState {
  const lines = bufferText.split("\n")
  const start = Math.max(0, Math.min(startLine, Math.max(0, lines.length - maxLines)))
  const visibleLineCount = Math.min(maxLines, Math.max(1, lines.length - start))
  const gutter = showLineNumbers ? gutterPrefixLen(start + 1, visibleLineCount) : 0
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
  const lineIdx = Math.max(0, Math.min(state.startLine + Math.max(0, row), lines.length - 1))
  const lineStart = lines.slice(0, lineIdx).join("\n").length + (lineIdx > 0 ? 1 : 0)
  const line = lines[lineIdx] ?? ""
  const visualPrefix = state.gutterPrefixLen + (state.leftPadding ?? 0)
  const colInLine = Math.max(0, Math.min(col - visualPrefix, line.length))
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
