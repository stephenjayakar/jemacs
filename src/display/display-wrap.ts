import type { BufferModel } from "../kernel/buffer"
import { getCustom } from "../runtime/custom"
import { modeFeature } from "../modes/mode"
import type { ThemedChunk, ThemedText } from "./themed-text"
import { gutterPrefixLen } from "./click-to-point"

const MARKDOWN_FILL_COLUMN = "markdown-fill-column"
const MARKDOWN_VISUAL_FILL = "markdown-visual-fill-column-mode"

/** Buffer text projected through the mode display filter (if any). */
export function displayTextForBuffer(buffer: BufferModel): string {
  return modeFeature(buffer.mode, "displayFilter")?.(buffer)?.text ?? buffer.text
}

export type PaneWrapLayout = {
  wrapCols?: number
  gutterPrefixLen: number
  wordWrap: boolean
}

/** Wrap width and gutter for a pane — shared by display build and scroll math. */
export function paneWrapLayout(
  buffer: BufferModel,
  cols: number | undefined,
  showLineNumbers: boolean,
  startLine: number,
  lineBudget: number,
): PaneWrapLayout {
  return paneWrapLayoutFor(displayTextForBuffer(buffer), buffer.locals, cols, showLineNumbers, startLine, lineBudget)
}

/** `paneWrapLayout` over a precomputed display text + locals (no `BufferModel`). */
export function paneWrapLayoutFor(
  displayText: string,
  locals: ReadonlyMap<string, unknown>,
  cols: number | undefined,
  showLineNumbers: boolean,
  startLine: number,
  lineBudget: number,
): PaneWrapLayout {
  const lineCount = displayText.split("\n").length
  const visibleLineCount = Math.min(lineBudget, Math.max(1, lineCount - startLine))
  const gutter = showLineNumbers ? gutterPrefixLen(startLine + 1, visibleLineCount) : 0
  const wordWrap = locals.get("word-wrap") === true
  if (cols == null) return { gutterPrefixLen: gutter, wordWrap }
  if (locals.get(MARKDOWN_VISUAL_FILL) !== true) {
    return { wrapCols: cols, gutterPrefixLen: gutter, wordWrap }
  }
  const fillColumn = locals.get(MARKDOWN_FILL_COLUMN) as number | undefined
    ?? getCustom<number>("markdown-fill-column")
    ?? 100
  const contentWidth = Math.max(1, cols - gutter)
  const columnWidth = Math.min(Math.max(1, Math.floor(fillColumn)), contentWidth)
  return { wrapCols: gutter + columnWidth, gutterPrefixLen: gutter, wordWrap }
}

/** Physical display rows after hard-wrapping a logical line. */
export function wrapRowsForContent(line: string | number, wrapCols: number, gutterPrefixLen: number, wordWrap = false): number {
  if (wrapCols <= gutterPrefixLen + 1) return 1
  if (!wordWrap || typeof line === "number") {
    const contentCols = wrapCols - gutterPrefixLen
    const lineLen = typeof line === "number" ? line : line.length
    if (lineLen <= contentCols) return 1
    return 1 + Math.ceil((lineLen - contentCols) / contentCols)
  }
  return wrapPlainLine(line, wrapCols, gutterPrefixLen, true).length
}

/** Hard-wrap themed body rows at `cols`, optionally breaking at word
 *  boundaries like Emacs `word-wrap`, and left-padding continuation rows by
 *  `padLen` so they align under buffer text rather than the line-number gutter. */
export function wrapBodyRows(
  body: ThemedText,
  cols: number | undefined,
  padLen: number,
  maxRows?: number,
  keepTop = false,
  wordWrap = false,
  keepRowContaining?: string,
): ThemedText {
  if (cols == null || cols <= padLen + 1) return body
  const logicalRows = splitLogicalRows(body)
  const rows = logicalRows.flatMap(row => wrapStyledLine(row, cols, padLen, wordWrap))
  const kept = maxRows != null && rows.length > maxRows
    ? keptWrappedRows(rows, maxRows, keepTop, keepRowContaining)
    : rows
  const out: ThemedChunk[] = []
  for (let i = 0; i < kept.length; i++) {
    if (i > 0) out.push({ text: "\n" })
    out.push(...chunksFromStyledChars(kept[i]!))
  }
  return { chunks: out }
}

type StyledChar = { ch: string; style: Omit<ThemedChunk, "text"> }

function keptWrappedRows(
  rows: StyledChar[][],
  maxRows: number,
  keepTop: boolean,
  keepRowContaining?: string,
): StyledChar[][] {
  const keepRow = keepRowContaining
    ? rows.findIndex(row => row.some(c => c.ch === keepRowContaining))
    : -1
  if (keepRow >= 0) {
    const first = keepTop && keepRow < maxRows
      ? 0
      : Math.max(0, Math.min(keepRow - maxRows + 1, rows.length - maxRows))
    return rows.slice(first, first + maxRows)
  }
  return keepTop ? rows.slice(0, maxRows) : rows.slice(rows.length - maxRows)
}

function splitLogicalRows(body: ThemedText): StyledChar[][] {
  const rows: StyledChar[][] = [[]]
  for (const chunk of body.chunks) {
    const { text, ...style } = chunk
    for (const ch of text) {
      if (ch === "\n") rows.push([])
      else rows[rows.length - 1]!.push({ ch, style })
    }
  }
  return rows
}

function wrapStyledLine(line: StyledChar[], cols: number, padLen: number, wordWrap: boolean): StyledChar[][] {
  const plain = line.map(c => c.ch).join("")
  const ranges = wrapPlainLine(plain, cols, padLen, wordWrap)
  const out: StyledChar[][] = []
  for (let i = 0; i < ranges.length; i++) {
    const [start, end] = ranges[i]!
    const row = i === 0 ? [] : padChars(padLen)
    row.push(...line.slice(start, end))
    out.push(row)
  }
  return out
}

function wrapPlainLine(line: string, cols: number, padLen: number, wordWrap: boolean): Array<[number, number]> {
  if (cols <= padLen + 1) return [[0, line.length]]
  const ranges: Array<[number, number]> = []
  let start = 0
  let first = true
  while (start < line.length || (first && line.length === 0)) {
    const capacity = first ? cols : cols - padLen
    if (start + capacity >= line.length) {
      ranges.push([start, line.length])
      break
    }
    let end = start + capacity
    if (wordWrap) {
      const boundary = wordWrapBoundary(line, start, end)
      if (boundary > start) end = boundary
    }
    ranges.push([start, end])
    start = end
    first = false
  }
  return ranges
}

function wordWrapBoundary(line: string, start: number, hardEnd: number): number {
  for (let i = hardEnd; i > start; i--) {
    if (/\s/.test(line[i - 1]!)) return i
  }
  return hardEnd
}

function padChars(count: number): StyledChar[] {
  return Array.from({ length: count }, () => ({ ch: " ", style: {} }))
}

function chunksFromStyledChars(chars: StyledChar[]): ThemedChunk[] {
  const chunks: ThemedChunk[] = []
  for (const { ch, style } of chars) {
    const last = chunks[chunks.length - 1]
    if (last && themedChunkStyleEqual(last, style)) last.text += ch
    else chunks.push({ text: ch, ...style })
  }
  return chunks
}

function themedChunkStyleEqual(a: Omit<ThemedChunk, "text">, b: Omit<ThemedChunk, "text">): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.italic === b.italic
    && a.underline === b.underline && a.family === b.family && a.height === b.height
    && a.heightScale === b.heightScale
}
