/**
 * Wrap display lines in pixels for hosts that draw proportional fonts.
 *
 * The char-grid path wraps at N characters. That is exact on a terminal, but a
 * DOM host draws a 2x heading or a variable-pitch paragraph at widths the
 * character count does not predict, so the browser used to wrap those rows a
 * second time. `C-n`, scrolling and clicks then disagreed with the screen.
 *
 * Here every consumer -- layout, row costs, `line-move-visual` -- measures the
 * same glyph widths (`FontMetricsTable`) against the same column width, and the
 * DOM draws each kernel row with `white-space: pre`, so a row can never wrap in
 * the browser. One wrap authority, like Emacs redisplay.
 */

import type { BufferModel } from "../kernel/buffer"
import type { FaceName, TextSpan } from "../modes/mode"
import { resolveFace } from "../runtime/faces"
import { getCustom } from "../runtime/custom"
import { applyTheme, type Theme } from "./theme"
import { styleToChunk, type ThemedChunk } from "./themed-text"
import { domFontDefaults, fontSpecFor, type FontDefaults, type FontMetricsTable, type FontStyleFields } from "./font-metrics"

/** Must match `DOM_FRAME_COL_PX`: the host derives `cols` from its pixel width. */
const COL_PX = 9
/** Pane margin (2px x2), border (1px x2) and body padding (8px x2), plus slack. */
export const PANE_CHROME_PX = 24

const MARKDOWN_VISUAL_FILL = "markdown-visual-fill-column-mode"
const MARKDOWN_FILL_COLUMN = "markdown-fill-column"
const MARKDOWN_VISUAL_FILL_CENTER = "markdown-visual-fill-column-center-text"
const MARKDOWN_VISUAL_FILL_ADJUST = "markdown-visual-fill-column-adjust-for-text-scale"

export type PixelWrapLayout = {
  /** Width available to text in the pane body, in px. */
  contentPx: number
  /** Width of the text column rows wrap at, in px. */
  columnPx: number
  /** Left margin that centres the column, in px. */
  leftPx: number
  defaults: FontDefaults
  metrics: FontMetricsTable
  wordWrap: boolean
  adaptiveWrap: boolean
  theme: Theme
  buffer?: BufferModel
  /** Line box height as a multiple of the font size (Emacs `line-spacing` on top of 1.35). */
  lineHeight: number
}

/** Least space either side of a text column that fills the window, in px. */
const COLUMN_MARGIN_PX = 32

/** Line box ratio of a DOM row without `line-spacing` (`DOM_FRAME_LINE_HEIGHT_RATIO`). */
const BASE_LINE_HEIGHT = 1.35

/**
 * How a row kind is drawn in a text column. The kernel owns these numbers:
 * `insetPx` narrows the wrap width and indents the row, `padTopPx` adds space
 * above the first row of a line, and both feed the scroll row costs, so the
 * DOM, `C-n` and scrolling all see the same geometry.
 */
/** An image a display line draws under its text; `width`/`height` are the file's px. */
export type DisplayImage = { src: string; width: number; height: number }

/** Tallest an inline image draws, and the gap around it: a screenshot should
 *  read as a figure in the text, not take over the window. */
const IMAGE_MAX_HEIGHT_PX = 420
const IMAGE_GAP_PX = 8

/** Display size of an inline image in the column (never upscaled). */
export function imageBox(layout: Pick<PixelWrapLayout, "columnPx">, image: DisplayImage): { widthPx: number; heightPx: number } {
  const scale = Math.min(1, layout.columnPx / image.width, IMAGE_MAX_HEIGHT_PX / image.height)
  return { widthPx: Math.round(image.width * scale), heightPx: Math.round(image.height * scale) }
}

/** Px an image adds under its line: the picture plus a gap above and below. */
export function imageBlockPx(layout: Pick<PixelWrapLayout, "columnPx">, image: DisplayImage): number {
  return imageBox(layout, image).heightPx + IMAGE_GAP_PX * 2
}

/** Vertical nesting guides in a row's inset: `count` 1px lines, the first at
 *  `startPx` from the row's left edge, then every `stepPx`. */
export type RowGuides = { startPx: number; stepPx: number; count: number }

export type RowDecoration = { insetPx: number; insetRightPx: number; padTopPx: number; guides?: RowGuides }

const NO_DECORATION: RowDecoration = { insetPx: 0, insetRightPx: 0, padTopPx: 0 }

/**
 * Buffer-local flag: the last frame drew this buffer on a host that measures
 * fonts. The markdown display filter then emits GUI-only glyphs (an empty row
 * for a rule, no quote bar) and row kinds, because CSS draws those parts.
 */
export const PIXEL_DISPLAY_LOCAL = "jemacs--pixel-display"

/** Space between a quote's rule and its text, and a code panel's padding. */
const QUOTE_INSET_PX = 18
const CODE_INSET_PX = 14
/** List geometry in ems of the body font, so it grows with text scale:
 *  top-level items sit this far in from the paragraph edge (Obsidian's list
 *  margin), and each nesting level steps in by `LIST_STEP_EM`. */
const LIST_BASE_EM = 1
const LIST_STEP_EM = 1.75
/** First GUI list bullet (`GUI_LIST_ITEM_BULLETS` in the markdown plugin): a
 *  nesting guide runs under the centre of its parent's bullet. */
const LIST_BULLET = "\u2981"

export function rowDecoration(layout: Pick<PixelWrapLayout, "theme" | "buffer" | "defaults" | "metrics">, kind: string | undefined): RowDecoration {
  if (!kind) return NO_DECORATION
  if (kind === "quote") return { insetPx: QUOTE_INSET_PX, insetRightPx: 0, padTopPx: 0 }
  if (kind === "code" || kind === "code-fence-open" || kind === "code-fence-close") {
    return { insetPx: CODE_INSET_PX, insetRightPx: CODE_INSET_PX, padTopPx: 0 }
  }
  const heading = /^heading-([1-6])$/.exec(kind)
  if (heading) {
    // Space above a heading grows with its size, as in Obsidian and Notion,
    // so a section break reads as one.
    const face = resolveFace(`markdown-header-face-${heading[1]}` as FaceName, layout.theme, layout.buffer)
    const px = fontSpecFor(styleToChunk(face), layout.defaults).px
    return { insetPx: 0, insetRightPx: 0, padTopPx: Math.round(px * 0.45) }
  }
  const list = /^list-(\d+)$/.exec(kind)
  if (list) {
    const depth = Number(list[1])
    const spec = fontSpecFor(styleToChunk(resolveFace("default", layout.theme, layout.buffer)), layout.defaults)
    const base = Math.round(spec.px * LIST_BASE_EM)
    const step = Math.round(spec.px * LIST_STEP_EM)
    const decoration: RowDecoration = { insetPx: base + depth * step, insetRightPx: 0, padTopPx: 0 }
    if (depth > 0) {
      decoration.guides = { startPx: base + Math.round(layout.metrics.advance(LIST_BULLET, spec) / 2), stepPx: step, count: depth }
    }
    return decoration
  }
  return NO_DECORATION
}

/**
 * Pixel wrap applies to buffers laid out as a text column
 * (`markdown-visual-fill-column-mode`) on a host that measured its fonts.
 * Code buffers and the terminal keep the character grid unchanged. A line
 * number gutter also keeps the grid: its width is counted in characters.
 */
export function pixelWrapFor(options: {
  locals: ReadonlyMap<string, unknown>
  cols: number | undefined
  showGutter: boolean
  perFaceFonts: boolean
  metrics: FontMetricsTable | undefined
  theme: Theme
  buffer?: BufferModel
  textScale: number
}): PixelWrapLayout | null {
  const { locals, cols, metrics, theme, buffer, textScale } = options
  if (!options.perFaceFonts || !metrics || cols == null || options.showGutter) return null
  if (locals.get(MARKDOWN_VISUAL_FILL) !== true) return null
  const defaults = domFontDefaults(theme.faces.default, textScale)
  const contentPx = Math.max(COL_PX * 4, cols * COL_PX - PANE_CHROME_PX)
  const fillColumn = (locals.get(MARKDOWN_FILL_COLUMN) as number | undefined)
    ?? getCustom<number>(MARKDOWN_FILL_COLUMN) ?? 100
  // `visual-fill-column` sizes the column from `window-font-width`: the average
  // glyph of the buffer's remapped `default` face, not the frame font.
  // With `visual-fill-column-adjust-for-text-scale` the column grows with text
  // scale, so zooming keeps `fill-column` characters per row. Without it the
  // column keeps its unscaled px width and zoomed text wraps sooner.
  const adjust = (locals.get(MARKDOWN_VISUAL_FILL_ADJUST) as boolean | undefined)
    ?? getCustom<boolean>(MARKDOWN_VISUAL_FILL_ADJUST) ?? true
  const columnDefaults = adjust ? defaults : domFontDefaults(theme.faces.default, 1)
  const bodySpec = fontSpecFor(styleToChunk(resolveFace("default", theme, buffer)), columnDefaults)
  const fillPx = Math.max(1, Math.floor(fillColumn)) * metrics.averageWidth(bodySpec)
  // Once the column is wider than the window, keep a side margin (Obsidian's
  // `--file-margins`) instead of running text into the pane border.
  const marginPx = Math.round(Math.min(COLUMN_MARGIN_PX, contentPx * 0.06))
  const columnPx = Math.floor(Math.max(COL_PX * 4, Math.min(fillPx, contentPx - marginPx * 2)))
  const center = (locals.get(MARKDOWN_VISUAL_FILL_CENTER) as boolean | undefined)
    ?? getCustom<boolean>(MARKDOWN_VISUAL_FILL_CENTER) ?? true
  const leftPx = center ? Math.max(0, Math.floor((contentPx - columnPx) / 2)) : 0
  return {
    contentPx,
    columnPx,
    leftPx,
    defaults,
    metrics,
    wordWrap: locals.get("word-wrap") === true,
    adaptiveWrap: locals.get("adaptive-wrap-prefix-mode") === true,
    theme,
    buffer,
    lineHeight: BASE_LINE_HEIGHT * (1 + lineSpacing(locals)),
  }
}

/** Emacs `line-spacing` as a fraction of the line height (a float); pixel values are ignored. */
function lineSpacing(locals: ReadonlyMap<string, unknown>): number {
  const value = locals.get("line-spacing")
  return typeof value === "number" && value > 0 && value < 1 ? value : 0
}

/** Advance of every UTF-16 unit of a styled run; a surrogate's low half is 0. */
export function chunkWidths(
  chunks: ReadonlyArray<ThemedChunk | { text: string } & FontStyleFields>,
  layout: Pick<PixelWrapLayout, "defaults" | "metrics">,
): number[] {
  const out: number[] = []
  for (const chunk of chunks) {
    const spec = fontSpecFor(chunk, layout.defaults)
    for (const ch of chunk.text) {
      out.push(layout.metrics.advance(ch, spec))
      if (ch.length === 2) out.push(0)
    }
  }
  return out
}

/** Width of one space in the pane's default font: continuation padding. */
export function padSpaceWidth(layout: Pick<PixelWrapLayout, "defaults" | "metrics">): number {
  return layout.metrics.advance(" ", fontSpecFor({}, layout.defaults))
}

/**
 * Row ranges `[start, end)` of one line whose glyph advances are `widths`.
 *
 * Every row after the first starts with `contPadPx` of continuation padding,
 * so it has that much less room. A row always takes at least one glyph, and
 * a surrogate's low half stays with the
 * glyph before them -- except the caret marker, which starts the next row:
 * Emacs draws point at a wrap boundary at the start of the continuation line,
 * and `line-move-visual` counts it there. With `wordWrap`, a row ends after the last whitespace
 * that fits, and whitespace at the break hangs at the end of the row, as in
 * Emacs `word-wrap`.
 */
export function wrapLinePx(
  line: ArrayLike<string>,
  widths: ArrayLike<number>,
  capacityPx: number,
  wordWrap: boolean,
  contPadPx = 0,
): Array<[number, number]> {
  if (line.length === 0) return [[0, 0]]
  const ranges: Array<[number, number]> = []
  let start = 0
  let first = true
  while (start < line.length) {
    const cap = first ? capacityPx : Math.max(capacityPx - contPadPx, capacityPx / 4)
    let used = 0
    let i = start
    while (i < line.length) {
      const w = widths[i] ?? 0
      if (w > 0 && i > start && used + w > cap + 0.01) break
      used += w
      i++
    }
    while (i < line.length && isLowSurrogate(line[i]!)) i++
    if (i >= line.length) {
      ranges.push([start, line.length])
      break
    }
    // Hand trailing caret markers to the next row (see the doc comment above).
    while (i - 1 > start && line[i - 1] === CARET_MARKER) i--
    let stop = i
    if (wordWrap) {
      if (/\s/.test(line[stop]!)) stop++
      const boundary = lastBreak(line, start, stop)
      if (boundary > start) stop = boundary
    }
    ranges.push([start, stop])
    start = stop
    first = false
  }
  return ranges
}

/** `CURSOR_MARKER_ZERO_WIDTH`, repeated here to keep this module import-light. */
const CARET_MARKER = "\u200b"

const isLowSurrogate = (ch: string) => ch.length === 1 && ch.charCodeAt(0) >= 0xdc00 && ch.charCodeAt(0) <= 0xdfff

function lastBreak(line: ArrayLike<string>, start: number, hardEnd: number): number {
  for (let i = hardEnd; i > start; i--) {
    if (/\s/.test(line[i - 1]!)) return i
  }
  return hardEnd
}

/** Characters of a line's adaptive-wrap prefix, as `adaptiveWrapPrefixLen` counts them. */
const LIST_PREFIX_RE = /^(\s*)(?:(?:[-*+\u25cf\u25ce\u25cb\u25c6\u25c7\u25ba\u2022\u25e6\u25aa\u2981\u26ac]|\d+[.)])\s+(?:[\u2610\u2611\u25a2\u2705]\s+)?|[\u2610\u2611\u25a2\u2705]\s+)/
const QUOTE_PREFIX_RE = /^(\s*[>\u258c]+\s*)/
export function adaptivePrefixLen(content: string): number {
  const list = LIST_PREFIX_RE.exec(content)
  if (list) return list[0].length
  const quote = QUOTE_PREFIX_RE.exec(content)
  if (quote) return quote[1]!.length
  return /^\s*/.exec(content)![0].length
}

/**
 * Spaces of continuation padding that line a wrapped row up under the text
 * after a `len`-character prefix starting at `from`. Counted in px, not in
 * characters: a bullet, a number or a task box is wider than a space in a
 * proportional font, so one space per prefix character left the second row
 * short of the first row's text.
 */
export function prefixPadSpaces(widths: ArrayLike<number>, from: number, len: number, spacePx: number): number {
  if (len <= 0 || spacePx <= 0) return Math.max(0, len)
  let px = 0
  for (let i = from; i < from + len; i++) px += widths[i] ?? 0
  return Math.round(px / spacePx)
}

/** Row ranges of a display line, themed with the spans that overlap it. */
export function pixelRowRanges(
  layout: PixelWrapLayout,
  line: string,
  lineSpans: TextSpan[],
  kind?: string,
): Array<[number, number]> {
  const chunks = applyTheme(line, lineSpans, layout.theme, { buffer: layout.buffer }).chunks
  const widths = chunkWidths(chunks, layout)
  const spacePx = padSpaceWidth(layout)
  const pad = layout.adaptiveWrap ? prefixPadSpaces(widths, 0, adaptivePrefixLen(line), spacePx) : 0
  const decoration = rowDecoration(layout, kind)
  const capacity = Math.max(layout.columnPx / 4, layout.columnPx - decoration.insetPx - decoration.insetRightPx)
  return wrapLinePx(line, widths, capacity, layout.wordWrap, pad * spacePx)
}

/** Row counts and the extra px above each line, the inputs of the scroll row costs. */
export type PixelLineCosts = { rowCounts: Map<number, number>; extraPx: Map<number, number> }

/**
 * Screen rows per display line for `fromLine..toLine`, from display-space spans.
 *
 * Spans are bucketed per line in one pass, so the cost is lines plus spans,
 * not their product.
 */
export function pixelRowCounts(
  layout: PixelWrapLayout,
  lines: readonly string[],
  spans: readonly TextSpan[],
  fromLine: number,
  toLine: number,
  kinds?: ReadonlyArray<string | undefined>,
  images?: ReadonlyArray<DisplayImage | undefined>,
): PixelLineCosts {
  const starts: number[] = new Array(lines.length)
  for (let i = 0, o = 0; i < lines.length; i++) { starts[i] = o; o += lines[i]!.length + 1 }
  const lo = Math.max(0, fromLine)
  const hi = Math.min(lines.length - 1, toLine)
  const buckets = new Map<number, TextSpan[]>()
  if (hi >= lo) {
    const rangeStart = starts[lo]!
    const rangeEnd = starts[hi]! + lines[hi]!.length
    for (const span of spans) {
      if (span.end <= rangeStart || span.start >= rangeEnd || span.end <= span.start) continue
      let line = lineIndexAt(starts, Math.max(span.start, rangeStart))
      for (; line <= hi && starts[line]! < span.end; line++) {
        const s = starts[line]!
        const e = s + lines[line]!.length
        if (span.start >= e && e > s) continue
        let bucket = buckets.get(line)
        if (!bucket) buckets.set(line, bucket = [])
        bucket.push({ ...span, start: Math.max(0, span.start - s), end: Math.min(lines[line]!.length, span.end - s) })
      }
    }
  }
  const rowCounts = new Map<number, number>()
  const extraPx = new Map<number, number>()
  for (let i = lo; i <= hi; i++) {
    const kind = kinds?.[i]
    rowCounts.set(i, pixelRowRanges(layout, lines[i]!, buckets.get(i) ?? [], kind).length)
    const image = images?.[i]
    const pad = rowDecoration(layout, kind).padTopPx + (image ? imageBlockPx(layout, image) : 0)
    if (pad) extraPx.set(i, pad)
  }
  return { rowCounts, extraPx }
}

function lineIndexAt(starts: readonly number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid]! <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** x position (px) of each offset `0..line.length` within its own row. */
export function rowXOffsets(widths: ArrayLike<number>, rows: Array<[number, number]>): number[] {
  const xs: number[] = []
  for (const [start, end] of rows) {
    let x = 0
    for (let i = start; i < end; i++) { xs[i] = x; x += widths[i] ?? 0 }
    xs[end] = x
  }
  return xs
}
