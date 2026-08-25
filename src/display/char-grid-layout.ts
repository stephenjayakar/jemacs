import type { MinibufferCompletionDisplay } from "../kernel/editor"
import type { TextSpan } from "../modes/mode"
import { getCustom } from "../runtime/custom"
import type { HostCapabilities } from "./protocol"
import { regionSpanWithCursor, textWithCursor } from "../ui/text-display"
import { cursorIsBlock } from "./cursor-type"
import { windowClickState } from "./click-to-point"
import { visibleStyledTextFromStart } from "./buffer-view"
import type { ChildFrameModel, DisplayModel, WindowDisplayNode, WindowPaneModel } from "./protocol"
import { bufferHighlightSpans } from "./buffer-highlights"
import { applyTheme, type Theme } from "./theme"
import { terminalSurfaceToThemedText, type TerminalSurfaceModel } from "./terminal-surface"
import { CURSOR_GLYPH, extractCursorMarker, plainThemedText, unitalicizeCharAt, type ThemedChunk, type ThemedText } from "./themed-text"
import { contentAreaLines, windowBodyLines, type ViewportSize } from "./viewport"
import { paneWrapLayoutFor, wrapBodyRowsWithMap } from "./display-wrap"
import {
  computeLineVisualRows,
  computeWrappedLineRows,
  hasNonUnitVisualRows,
  syncViewportStartLine,
  visibleLineCountForBudget,
  visualRowLineRange,
} from "./visual-line-height"
import type { LogicalChildFrame, LogicalModel, LogicalPane, LogicalWindowNode } from "./logical"
import { pointLineCol } from "./logical"

/** Project a `LogicalModel` onto a fixed character grid: split row/column
 *  budgets across the window tree, wrap/slice each pane's text into the
 *  visible region, and theme the minibuffer/completion rows. Pure. */
export function layoutCharGrid(
  logical: LogicalModel,
  viewport: ViewportSize,
  hostCapabilities?: HostCapabilities,
): DisplayModel {
  const completionLines = logical.completion?.text
    ? Math.max(1, logical.completion.text.split("\n").length)
    : 0
  // Minibuffer may carry a multi-line completion overlay (fido); steal those rows from the window stack.
  // The tab bar takes one more row above the windows when it is shown.
  const areaLines = Math.max(2, contentAreaLines(viewport.rows) - completionLines - logical.overlayRows - (logical.tabBar ? 1 : 0))
  const windows = layoutWindowTree(logical, logical.windows, areaLines, viewport.cols, hostCapabilities)
  const childFrames = logical.childFrames.map(frame => layoutChildFrame(logical, frame, viewport, hostCapabilities))

  return {
    title: logical.title,
    tabBar: logical.tabBar ? applyTheme(logical.tabBar.text, logical.tabBar.spans, logical.theme) : undefined,
    windows,
    childFrames,
    minibufferCompletions: themedCompletions(logical.completion, logical.theme),
    minibufferCompletionLines: completionLines,
    minibuffer: themedMinibuffer(logical, logical.theme),
    echo: logical.echo,
    theme: logical.theme,
    viewport,
    hostLabel: logical.hostLabel,
  }
}

function layoutChildFrame(
  logical: LogicalModel,
  frame: LogicalChildFrame,
  viewport: ViewportSize,
  hostCapabilities?: HostCapabilities,
): ChildFrameModel {
  const width = clampInt(numberParam(frame.parameters.width), 20, Math.max(20, viewport.cols ?? 80), Math.min(72, Math.max(20, (viewport.cols ?? 80) - 4)))
  const height = clampInt(numberParam(frame.parameters.height), 3, Math.max(3, viewport.rows - 3), Math.min(12, Math.max(3, viewport.rows - 4)))
  const maxLeft = Math.max(0, (viewport.cols ?? width) - width)
  const maxTop = Math.max(1, viewport.rows - height - 1)
  const left = clampInt(numberParam(frame.parameters.left), 0, maxLeft, Math.max(0, Math.min(maxLeft, (viewport.cols ?? width) - width - 2)))
  const top = clampInt(numberParam(frame.parameters.top), 1, maxTop, Math.min(maxTop, 2))
  const leaf = { kind: "leaf" as const, id: `${frame.id}:window`, pane: frame.pane, dedicated: true }
  return {
    id: frame.id,
    parentFrameId: frame.parentFrameId,
    pane: layoutLeafPane(logical, leaf, height, width, hostCapabilities),
    top,
    left,
    width,
    height,
  }
}

function numberParam(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  return Math.max(min, Math.min(max, value ?? fallback))
}

function layoutWindowTree(
  logical: LogicalModel,
  node: LogicalWindowNode,
  availableLines: number,
  availableCols?: number,
  hostCapabilities?: HostCapabilities,
): WindowDisplayNode {
  if (node.kind === "leaf") {
    return {
      kind: "leaf",
      pane: layoutLeafPane(logical, node, availableLines, availableCols, hostCapabilities),
      lineBudget: availableLines,
    }
  }
  const lines = splitLineBudget(availableLines, node.direction, node.ratio)
  const cols = splitColBudget(availableCols, node.direction, node.ratio)
  return {
    kind: "split",
    direction: node.direction,
    firstRatio: node.ratio,
    first: layoutWindowTree(logical, node.first, lines.first, cols.first, hostCapabilities),
    second: layoutWindowTree(logical, node.second, lines.second, cols.second, hostCapabilities),
  }
}

function layoutLeafPane(
  logical: LogicalModel,
  leaf: Extract<LogicalWindowNode, { kind: "leaf" }>,
  availableLines: number,
  availableCols?: number,
  hostCapabilities?: HostCapabilities,
): WindowPaneModel {
  const pane = leaf.pane
  const bodyAndFooterLines = windowBodyLines(availableLines)
  const footerLines = footerLineCount(pane.footer?.text, bodyAndFooterLines)
  const maxLines = Math.max(1, bodyAndFooterLines - footerLines)
  const footer = pane.footer?.text ? applyTheme(pane.footer.text, pane.footer.spans ?? [], logical.theme) : undefined
  if (!pane.buffer) {
    return {
      id: leaf.id,
      bufferId: pane.bufferId,
      selected: pane.selected,
      dedicated: leaf.dedicated,
      body: plainThemedText(""),
      terminalSurface: undefined,
      tableSurface: undefined,
      webSurface: undefined,
      footer,
      modeline: pane.modeline,
      clickState: { startLine: 0, gutterPrefixLen: 0 },
      bodyLineBudget: maxLines,
      syncText: "",
      syncPoint: 0,
      syncSpans: [],
      textScale: 1,
    }
  }

  const useRaw = hostCapabilities?.terminalRawStreams === true
  // Raw-stream hosts (Electron) run their own terminal emulator and receive
  // cell content over a separate byte channel, so they only need the surface's
  // shape -- a momentarily stale grid still renders correctly. Gating them on
  // exact dimensions drops the pane out of this branch during the window
  // between a layout change and the pty resize that follows it, which swaps the
  // pane (and its modeline) to the themed-text fallback and back on every
  // resize. That engine swap is what reads as judder in the GUI.
  // Hosts that paint the grid from these cells still need an exact fit.
  const surface = useRaw
    ? pane.terminalSurface
    : activeTerminalSurface(pane.terminalSurface, maxLines, availableCols)
  if (surface) {
    return {
      id: leaf.id,
      bufferId: pane.bufferId,
      selected: pane.selected,
      dedicated: leaf.dedicated,
      body: useRaw ? plainThemedText("") : terminalSurfaceToThemedText(surface),
      terminalSurface: useRaw ? terminalSurfaceMetadata(surface) : surface,
      tableSurface: undefined,
      webSurface: undefined,
      footer,
      modeline: pane.terminalModeline ?? pane.modeline,
      clickState: { startLine: 0, gutterPrefixLen: 0 },
      bodyLineBudget: maxLines,
      syncText: pane.text,
      syncPoint: pane.point,
      syncSpans: [],
      textScale: pane.textScale,
    }
  }

  // Normalize to display-space (t-audit2-df12aac9): startLine arrives as a
  // raw-text line index, but every consumer below slices/wraps/row-weights
  // `displayText`. Map offsets once here and stay in one index space.
  const map = pane.displayMap
  const dText = pane.displayText
  const dPoint = map ? map(pane.point) : pane.point
  const mark = pane.markActive ? pane.mark : null
  const dMark = map && mark != null ? map(mark) : mark
  const dSpans = map ? pane.spans.map(s => ({ ...s, start: map(s.start), end: map(s.end) })) : pane.spans
  const dFontLockSpans = map
    ? pane.fontLockSpans.map(s => ({ ...s, start: map(s.start), end: map(s.end) }))
    : pane.fontLockSpans
  const gutterDecorations = pane.gutterDecorations ?? []
  const showGutter = pane.showLineNumbers || gutterDecorations.length > 0
  const dLines = dText.split("\n")
  const lineCount = dLines.length
  let startLine = Math.max(0, Math.min(pane.startLine, lineCount - 1))
  const cursorLine = pane.selected ? pointLineCol(dText, dPoint).line - 1 : startLine
  const wrapLayout = paneWrapLayoutFor(
    dText,
    pane.locals,
    availableCols,
    showGutter,
    startLine,
    maxLines,
    cursorLine + 1,
  )
  const useVisualWeights = hostCapabilities?.perFaceFonts === true
  const lineRange = visualRowLineRange(startLine, cursorLine, maxLines, lineCount)
  const wrappedRows = useVisualWeights ? undefined : computeWrappedLineRows(dLines, {
    wrapCols: wrapLayout.wrapCols,
    gutterPrefixLen: wrapLayout.gutterPrefixLen,
    wordWrap: wrapLayout.wordWrap,
    adaptiveWrap: wrapLayout.adaptiveWrap,
    fromLine: lineRange.fromLine,
    toLine: lineRange.toLine,
  })
  const visualRows = useVisualWeights
    ? computeLineVisualRows(dText, dFontLockSpans, logical.theme, pane.buffer, pane.textScale, {
      wrapCols: wrapLayout.wrapCols,
      gutterPrefixLen: wrapLayout.gutterPrefixLen,
      wordWrap: wrapLayout.wordWrap,
      adaptiveWrap: wrapLayout.adaptiveWrap,
      displayLines: dLines,
      fromLine: lineRange.fromLine,
      toLine: lineRange.toLine,
    })
    : hasNonUnitVisualRows(wrappedRows) ? wrappedRows : undefined
  if (pane.selected) {
    // Keep point on-screen — same correction the shim wrote back to the editor.
    startLine = syncViewportStartLine(startLine, cursorLine, maxLines, visualRows)
  }
  const displayLines = visualRows
    ? visibleLineCountForBudget(startLine, maxLines, lineCount, visualRows)
    : maxLines
  const syncSpans = bufferHighlightSpans(pane.point, mark, pane.spans)
  const clickState = windowClickState(dText, startLine, displayLines, showGutter, cursorLine + 1)
  if (pane.displayUnmap) clickState.displayToBuffer = pane.displayUnmap
  // Hosts hard-wrap overflowing rows at column 0, which paints continuation
  // text into the next line's gutter (t-16be1a86). Pre-wrap here so every
  // continuation row carries the gutter's left padding.
  // Hosts with real font metrics draw their own caret, so the █ is only a
  // placeholder we extract below -- it must not eat the character under point.
  const hostDrawsCaret = hostCapabilities?.perFaceFonts === true
  const keepWrappedTop = startLine === 0
  const { wrapCols, gutterPrefixLen: gutter, wordWrap, adaptiveWrap } = paneWrapLayoutFor(
    dText,
    pane.locals,
    availableCols,
    showGutter,
    startLine,
    displayLines,
    cursorLine + 1,
  )
  const visualFill = visualFillSettings(pane.locals)
  const contentWidth = availableCols != null
    ? Math.max(1, availableCols - clickState.gutterPrefixLen)
    : undefined
  const columnWidth = visualFill && contentWidth != null && wrapCols != null
    ? wrapCols - clickState.gutterPrefixLen
    : undefined
  const wrapped = wrapBodyRowsWithMap(
    visibleStyledTextFromStart(dText, dPoint, startLine, {
      mark: dMark,
      spans: dSpans,
      theme: logical.theme,
      buffer: pane.buffer,
      maxLines: displayLines,
      showLineNumbers: showGutter,
      gutterDecorations,
      showCursor: pane.selected,
      cursorMode: hostDrawsCaret ? "insert" : "overwrite",
    }),
    wrapCols,
    gutter,
    maxLines,
    keepWrappedTop,
    wordWrap,
    pane.selected ? CURSOR_GLYPH : undefined,
    adaptiveWrap,
  )
  let body = wrapped.text
  // Without this a click below a wrapped line reads its physical row as a
  // logical-line offset and lands too far down the buffer (one row of drift per
  // continuation row above it). Omitted when no line wrapped, so the common
  // case keeps the previous (identical) mapping and a smaller wire payload.
  if (wrapped.rows.some((r, i) => r.line !== i)) clickState.wrappedRows = wrapped.rows
  if (visualFill?.center && columnWidth != null && contentWidth != null && columnWidth < contentWidth) {
    const leftMargin = Math.floor((contentWidth - columnWidth) / 2)
    if (leftMargin > 0) {
      clickState.leftPadding = leftMargin
      body = padBodyLines(body, " ".repeat(leftMargin))
    }
  }
  // Hosts that measure real glyphs draw their own caret, so hand them a
  // position and take the block glyph back out. Done after wrapping/padding so
  // the row/col are the ones actually rendered.
  let cursor: { row: number; colOffset: number; shape?: "bar" | "box" } | undefined
  if (pane.selected && hostDrawsCaret) {
    const extracted = extractCursorMarker(body)
    if (extracted) {
      body = extracted.text
      // `shape` omitted for the default bar so the wire model stays minimal.
      cursor = cursorIsBlock() ? { ...extracted.cursor, shape: "box" } : extracted.cursor
    }
  }

  return {
    id: leaf.id,
    bufferId: pane.bufferId,
    selected: pane.selected,
    dedicated: leaf.dedicated,
    body,
    cursor,
    terminalSurface: undefined,
    tableSurface: hostCapabilities?.richTables ? pane.tableSurface : undefined,
    // Terminal hosts drop this and fall back to `body`, which is why every web surface
    // must have a text rendering behind it.
    webSurface: hostCapabilities?.webSurfaces ? pane.webSurface : undefined,
    footer,
    modeline: pane.modeline,
    clickState,
    bodyLineBudget: maxLines,
    syncText: pane.text,
    syncPoint: pane.point,
    syncSpans,
    textScale: pane.textScale,
  }
}

function footerLineCount(text: string | undefined, bodyAndFooterLines: number): number {
  if (!text) return 0
  return Math.min(Math.max(0, bodyAndFooterLines - 1), Math.max(1, text.split("\n").length))
}

function activeTerminalSurface(
  surface: TerminalSurfaceModel | undefined,
  rows: number,
  cols?: number,
): TerminalSurfaceModel | undefined {
  if (!surface) return undefined
  if (surface.rows !== rows) return undefined
  if (cols != null && surface.cols !== cols) return undefined
  return surface
}

/** Cell-free copy of a surface for raw-stream hosts, which receive the actual
 *  content over their own byte channel and need only its shape.
 *
 *  `rows`/`cols` deliberately report the *emulator's* dimensions rather than
 *  the pane's current budget. Raw-stream hosts key their terminal instance by
 *  `bufferId`, so one buffer shown in two windows produces two panes backed by
 *  a single emulator; reporting per-pane budgets would make those panes fight
 *  over its size on every frame. The emulator's own size is the one value all
 *  panes of a buffer agree on, and the pty resize that follows a layout change
 *  brings it to the target shortly after. */
function terminalSurfaceMetadata(surface: TerminalSurfaceModel): TerminalSurfaceModel {
  return {
    kind: "terminal",
    rows: surface.rows,
    cols: surface.cols,
    cursorRow: surface.cursorRow,
    cursorCol: surface.cursorCol,
    cells: [],
  }
}

export function splitLineBudget(availableLines: number, direction: "horizontal" | "vertical", firstRatio = 0.5): { first: number; second: number } {
  if (direction === "horizontal") {
    return { first: availableLines, second: availableLines }
  }
  const first = proportionalBudget(availableLines, firstRatio, 3)
  return { first, second: Math.max(3, availableLines - first) }
}

export function splitColBudget(cols: number | undefined, direction: "horizontal" | "vertical", firstRatio = 0.5): { first?: number; second?: number } {
  if (cols == null) return {}
  if (direction === "vertical") return { first: cols, second: cols }
  const first = proportionalBudget(cols, firstRatio, 1)
  return { first, second: cols - first }
}

function proportionalBudget(total: number, firstRatio: number, min: number): number {
  if (total <= min * 2) return Math.floor(total / 2)
  const ratio = Math.max(0.05, Math.min(0.95, firstRatio))
  return Math.max(min, Math.min(total - min, Math.floor(total * ratio)))
}

/** Emacs `visual-fill-column-mode` for markdown buffers: narrow wrap width and
 *  optional centering (see `~/.emacs.d/stephen.el` markdown-mode-hook). */
function visualFillSettings(locals: ReadonlyMap<string, unknown>): { fillColumn: number; center: boolean } | null {
  if (locals.get("markdown-visual-fill-column-mode") !== true) return null
  const fillColumn = locals.get(MARKDOWN_FILL_COLUMN) as number | undefined
    ?? getCustom<number>(MARKDOWN_FILL_COLUMN)
    ?? 100
  const center = locals.get(MARKDOWN_VISUAL_FILL_CENTER) as boolean | undefined
    ?? getCustom<boolean>(MARKDOWN_VISUAL_FILL_CENTER)
    ?? true
  return { fillColumn: Math.max(1, Math.floor(fillColumn)), center }
}

const MARKDOWN_FILL_COLUMN = "markdown-fill-column"
const MARKDOWN_VISUAL_FILL_CENTER = "markdown-visual-fill-column-center-text"

/** Prefix every body row (including wrapped continuations) with `leftPad`. */
function padBodyLines(body: ThemedText, leftPad: string): ThemedText {
  if (!leftPad) return body
  const out: ThemedChunk[] = [{ text: leftPad }]
  let lastIsPad = true
  const append = (style: ThemedChunk, ch: string) => {
    const last = out[out.length - 1]!
    if (!lastIsPad && themedChunkStyleEqual(last, style) && !last.text.endsWith("\n")) {
      last.text += ch
      return
    }
    out.push({ ...style, text: ch })
    lastIsPad = false
  }
  for (const chunk of body.chunks) {
    for (const ch of chunk.text) {
      append(chunk, ch)
      if (ch === "\n") {
        out.push({ text: leftPad })
        lastIsPad = true
      }
    }
  }
  return { chunks: out }
}

function themedChunkStyleEqual(a: ThemedChunk, b: ThemedChunk): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.italic === b.italic
    && a.underline === b.underline && a.family === b.family && a.height === b.height
    && a.heightScale === b.heightScale
}

function themedCompletions(display: MinibufferCompletionDisplay | null, theme: Theme): ThemedText {
  if (!display?.text) return applyTheme("", [], theme)
  const text = display.text
  const spans = []
  if (display.selectedLine != null) {
    const lines = text.split("\n")
    let start = 0
    for (let i = 0; i < Math.min(display.selectedLine, lines.length); i++) start += lines[i]!.length + 1
    const end = start + (lines[display.selectedLine]?.length ?? 0)
    if (end > start) spans.push({ start, end, face: "highlight" as const })
  }
  return applyTheme(text, spans, theme)
}

function themedMinibuffer(logical: LogicalModel, theme: Theme): ThemedText {
  const mb = logical.minibuffer
  if (!mb) return applyTheme(" ", [], theme)
  const text = mb.mask ? mb.text.replace(/[^\n]/g, "•") : mb.text
  const input = textWithCursor(text, mb.point)
  const minibufferText = mb.prompt + input
  // Vertico can preselect the prompt instead of a candidate; then the input
  // line is what carries `vertico-current', so it gets the same `highlight'
  // face the selected candidate row would have. `highlight' is not `region':
  // the mark below must stay visible on top of a highlighted row.
  const inputFace = logical.completion?.promptSelected ? "highlight" : "minibuffer"
  const spans: TextSpan[] = [
    { start: 0, end: mb.prompt.length, face: "minibufferPrompt" },
    { start: mb.prompt.length, end: minibufferText.length, face: inputFace },
  ]
  // C-SPC works in the minibuffer like any other buffer, so the active region
  // has to be visible there too. It sits after the prompt, and wins over the
  // plain input face because later spans merge on top.
  const region = regionSpanWithCursor(text, mb.point, mb.mark)
  if (region) {
    spans.push({
      start: mb.prompt.length + region.start,
      end: mb.prompt.length + region.end,
      face: "region",
    })
  }
  return unitalicizeCharAt(applyTheme(minibufferText, spans, theme),
    mb.prompt.length + Math.max(0, Math.min(mb.point, text.length)))
}
