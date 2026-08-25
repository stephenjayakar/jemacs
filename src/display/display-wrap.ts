import type { BufferModel } from "../kernel/buffer"
import { getCustom } from "../runtime/custom"
import { modeFeature } from "../modes/mode"
import type { ThemedChunk, ThemedText } from "./themed-text"
import { gutterPrefixLen } from "./click-to-point"

const MARKDOWN_FILL_COLUMN = "markdown-fill-column"
const MARKDOWN_VISUAL_FILL = "markdown-visual-fill-column-mode"
const ADAPTIVE_WRAP = "adaptive-wrap-prefix-mode"
const LIST_PREFIX_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+/
const QUOTE_PREFIX_RE = /^(\s*>+\s*)/

export type DisplayFilterResult = { text: string; map: (n: number) => number; unmap?: (n: number) => number }

/** Buffer text projected through the mode display filter (if any). */
export function displayTextForBuffer(buffer: BufferModel): string {
  return displayFilterForBuffer(buffer)?.text ?? buffer.text
}

export function displayFilterForBuffer(buffer: BufferModel): DisplayFilterResult | null {
  return applyRestrictionDisplayFilter(buffer, modeFeature(buffer.mode, "displayFilter")?.(buffer) ?? null)
}

export function applyRestrictionDisplayFilter(buffer: BufferModel, filter: DisplayFilterResult | null): DisplayFilterResult | null {
  if (!buffer.isNarrowed) return filter
  const start = buffer.pointMin
  const end = buffer.pointMax
  const baseText = filter?.text ?? buffer.text
  const baseMap = filter?.map ?? ((n: number) => Math.max(0, Math.min(n, buffer.text.length)))
  const baseUnmap = filter?.unmap
  const displayStart = Math.max(0, Math.min(baseMap(start), baseText.length))
  const displayEnd = Math.max(displayStart, Math.min(baseMap(end), baseText.length))
  const text = baseText.slice(displayStart, displayEnd)
  return {
    text,
    map: n => Math.max(0, Math.min(displayEnd, baseMap(Math.max(start, Math.min(end, n)))) - displayStart),
    unmap: n => {
      const local = Math.max(0, Math.min(n, text.length))
      const displayPoint = displayStart + local
      const raw = baseUnmap ? baseUnmap(displayPoint) : start + local
      return Math.max(start, Math.min(end, raw))
    },
  }
}

export type PaneWrapLayout = {
  wrapCols?: number
  gutterPrefixLen: number
  wordWrap: boolean
  adaptiveWrap: boolean
}

/**
 * Emacs `adaptive-wrap-prefix-mode`: continuation rows of a wrapped line are
 * indented to that line's own prefix, so a bullet's second row starts under
 * its text instead of snapping back to column 0.
 */
export function adaptiveWrapPrefixLen(content: string): number {
  const list = LIST_PREFIX_RE.exec(content)
  if (list) return list[0].length
  const quote = QUOTE_PREFIX_RE.exec(content)
  if (quote) return quote[1]!.length
  return /^\s*/.exec(content)![0].length
}

/** Wrap width and gutter for a pane — shared by display build and scroll math. */
export function paneWrapLayout(
  buffer: BufferModel,
  cols: number | undefined,
  showLineNumbers: boolean,
  startLine: number,
  lineBudget: number,
): PaneWrapLayout {
  return paneWrapLayoutFor(displayTextForBuffer(buffer), buffer.locals, cols, showLineNumbers, startLine, lineBudget, buffer.lineAt(buffer.point) + 1)
}

/** `paneWrapLayout` over a precomputed display text + locals (no `BufferModel`). */
export function paneWrapLayoutFor(
  displayText: string,
  locals: ReadonlyMap<string, unknown>,
  cols: number | undefined,
  showLineNumbers: boolean,
  startLine: number,
  lineBudget: number,
  currentLine = startLine + 1,
): PaneWrapLayout {
  const lineCount = displayText.split("\n").length
  const visibleLineCount = Math.min(lineBudget, Math.max(1, lineCount - startLine))
  const gutter = showLineNumbers ? gutterPrefixLen(startLine + 1, visibleLineCount, currentLine) : 0
  const wordWrap = locals.get("word-wrap") === true
  const adaptiveWrap = locals.get(ADAPTIVE_WRAP) === true
  if (cols == null) return { gutterPrefixLen: gutter, wordWrap, adaptiveWrap }
  if (locals.get(MARKDOWN_VISUAL_FILL) !== true) {
    return { wrapCols: cols, gutterPrefixLen: gutter, wordWrap, adaptiveWrap }
  }
  const fillColumn = locals.get(MARKDOWN_FILL_COLUMN) as number | undefined
    ?? getCustom<number>("markdown-fill-column")
    ?? 100
  const contentWidth = Math.max(1, cols - gutter)
  const columnWidth = Math.min(Math.max(1, Math.floor(fillColumn)), contentWidth)
  return { wrapCols: gutter + columnWidth, gutterPrefixLen: gutter, wordWrap, adaptiveWrap }
}

/** Physical display rows after hard-wrapping a logical line. */
export function wrapRowsForContent(
  line: string | number,
  wrapCols: number,
  gutterPrefixLen: number,
  wordWrap = false,
  adaptiveWrap = false,
): number {
  if (wrapCols <= gutterPrefixLen + 1) return 1
  if ((!wordWrap && !adaptiveWrap) || typeof line === "number") {
    const contentCols = wrapCols - gutterPrefixLen
    const lineLen = typeof line === "number" ? line : line.length
    if (lineLen <= contentCols) return 1
    return 1 + Math.ceil((lineLen - contentCols) / contentCols)
  }
  return wrapPlainLine(line, wrapCols, gutterPrefixLen, wordWrap, adaptiveWrap ? adaptiveWrapPrefixLen(line) : 0).length
}

/** Visual (wrapped) row ranges of one logical line's content. */
export function visualRowRanges(line: string, wrapCols: number, wordWrap: boolean, adaptiveWrap: boolean): Array<[number, number]> {
  return wrapPlainLine(line, wrapCols, 0, wordWrap, adaptiveWrap ? adaptiveWrapPrefixLen(line) : 0)
}

/**
 * Emacs `line-move-visual`: in a soft-wrapped buffer `C-n`/`C-p` walk screen
 * rows, not logical lines. Returns false when there is no wrap geometry yet so
 * the caller can fall back to logical movement.
 */
export function visualLineMove(buffer: BufferModel, delta: number): boolean {
  if (delta === 0) return true
  if (buffer.locals.get("word-wrap") !== true) return false
  const cols = buffer.locals.get("window-body-cols") as number | undefined
  if (cols == null) return false
  const layout = paneWrapLayoutFor(buffer.text, buffer.locals, cols, false, 0, 1)
  if (layout.wrapCols == null) return false
  const wrapCols = layout.wrapCols - layout.gutterPrefixLen
  if (wrapCols <= 1) return false

  const lines = buffer.text.split("\n")
  const rowsFor = (i: number) => visualRowRanges(lines[i] ?? "", wrapCols, layout.wordWrap, layout.adaptiveWrap)
  let line = buffer.lineAt(buffer.point)
  let rows = rowsFor(line)
  const offset = buffer.point - buffer.lineBounds(line)[0]
  // Rows are contiguous, so an offset on a boundary belongs to the row it
  // starts, matching where Emacs paints the caret on a soft-wrapped line.
  let row = rows.findIndex(([start, end]) => offset >= start && offset < end)
  if (row < 0) row = rows.length - 1
  const goal = buffer.goalColumn ?? offset - rows[row]![0]

  let remaining = Math.abs(delta)
  const step = delta > 0 ? 1 : -1
  while (remaining > 0) {
    if (row + step >= 0 && row + step < rows.length) {
      row += step
    } else if (line + step >= 0 && line + step < lines.length) {
      line += step
      rows = rowsFor(line)
      row = step > 0 ? 0 : rows.length - 1
    } else break
    remaining--
  }

  const [start, end] = rows[row]!
  buffer.point = buffer.lineBounds(line)[0] + start + Math.min(goal, end - start)
  buffer.goalColumn = goal
  return true
}

/**
 * One rendered physical row, in the coordinates of the source line it came from.
 *
 * `line` indexes the logical rows of the body that was wrapped (row 0 is the
 * first visible line), and `[start, end)` are character offsets into that
 * line's *content*: the line-number gutter and the cursor marker are both
 * discounted, so the range indexes the underlying display text directly.
 * Hit-testing needs this because one logical line can render as many rows.
 *
 * `pad` is the row's own left padding (gutter plus any adaptive-wrap prefix),
 * which the click hit-test subtracts before indexing `[start, end)`.
 */
export type WrappedRow = { line: number; start: number; end: number; pad?: number }

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
  adaptiveWrap = false,
): ThemedText {
  return wrapBodyRowsWithMap(body, cols, padLen, maxRows, keepTop, wordWrap, keepRowContaining, adaptiveWrap).text
}

/** `wrapBodyRows` plus the row map the click hit-test needs to invert it. */
export function wrapBodyRowsWithMap(
  body: ThemedText,
  cols: number | undefined,
  padLen: number,
  maxRows?: number,
  keepTop = false,
  wordWrap = false,
  keepRowContaining?: string,
  adaptiveWrap = false,
): { text: ThemedText; rows: WrappedRow[] } {
  const logicalRows = splitLogicalRows(body)
  // Report ranges against the line's content: drop the gutter that was
  // prepended to every line, and the one-character cursor marker if this body
  // carries one, so callers can index the display text without redoing either.
  const content = (row: StyledChar[], n: number): number => {
    const marker = keepRowContaining ? row.findIndex(c => c.ch === keepRowContaining) : -1
    return Math.max(0, (marker >= 0 && n > marker ? n - 1 : n) - padLen)
  }
  // Too narrow to wrap: every logical row renders as exactly one physical row,
  // and the body is handed back untouched (including any overflow rows).
  if (cols == null || cols <= padLen + 1) {
    return {
      text: body,
      rows: logicalRows.map((row, line) => ({ line, start: 0, end: content(row, row.length), pad: padLen })),
    }
  }
  const rows: StyledChar[][] = []
  const map: WrappedRow[] = []
  logicalRows.forEach((row, line) => {
    const text = row.map(c => c.ch).join("")
    // The gutter/cursor glyph sit in front of the buffer text, so measure the
    // adaptive prefix on the content itself, not on the rendered row.
    const extraPad = adaptiveWrap ? adaptiveWrapPrefixLen(text.slice(padLen).replace(/^[\u2588]/, "")) : 0
    for (const [start, end] of wrapPlainLine(text, cols, padLen, wordWrap, extraPad)) {
      const continuation = map.length > 0 && map[map.length - 1]!.line === line
      const pad = continuation ? padLen + extraPad : padLen
      const out = continuation ? padChars(pad) : []
      out.push(...row.slice(start, end))
      rows.push(out)
      map.push({ line, start: content(row, start), end: content(row, end), pad })
    }
  })
  const [from, to] = maxRows != null && rows.length > maxRows
    ? keptRowRange(rows, maxRows, keepTop, keepRowContaining)
    : [0, rows.length]
  const out: ThemedChunk[] = []
  for (let i = from; i < to; i++) {
    if (i > from) out.push({ text: "\n" })
    out.push(...chunksFromStyledChars(rows[i]!))
  }
  return { text: { chunks: out }, rows: map.slice(from, to) }
}

type StyledChar = { ch: string; style: Omit<ThemedChunk, "text"> }

/** Which slice of the wrapped rows survives the `maxRows` budget, as `[from, to)`. */
function keptRowRange(
  rows: StyledChar[][],
  maxRows: number,
  keepTop: boolean,
  keepRowContaining?: string,
): [number, number] {
  const keepRow = keepRowContaining
    ? rows.findIndex(row => row.some(c => c.ch === keepRowContaining))
    : -1
  if (keepRow >= 0) {
    const first = keepTop && keepRow < maxRows
      ? 0
      : Math.max(0, Math.min(keepRow - maxRows + 1, rows.length - maxRows))
    return [first, first + maxRows]
  }
  return keepTop ? [0, maxRows] : [rows.length - maxRows, rows.length]
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

function wrapPlainLine(line: string, cols: number, padLen: number, wordWrap: boolean, extraPad = 0): Array<[number, number]> {
  if (cols <= padLen + 1) return [[0, line.length]]
  // An adaptive prefix wider than the text area would make no progress.
  const pad = cols > padLen + extraPad + 1 ? padLen + extraPad : padLen
  const ranges: Array<[number, number]> = []
  let start = 0
  let first = true
  while (start < line.length || (first && line.length === 0)) {
    const capacity = first ? cols : cols - pad
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
