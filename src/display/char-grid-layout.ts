import type { MinibufferCompletionDisplay } from "../kernel/editor"
import { getCustom } from "../runtime/custom"
import type { HostCapabilities } from "./protocol"
import { textWithCursor } from "../ui/text-display"
import { windowClickState } from "./click-to-point"
import { visibleStyledTextFromStart } from "./buffer-view"
import type { ChildFrameModel, DisplayModel, WindowDisplayNode, WindowPaneModel } from "./protocol"
import { bufferHighlightSpans } from "./buffer-highlights"
import { applyTheme, type Theme } from "./theme"
import { terminalSurfaceToThemedText, type TerminalSurfaceModel } from "./terminal-surface"
import { plainThemedText, type ThemedChunk, type ThemedText } from "./themed-text"
import { contentAreaLines, windowBodyLines, type ViewportSize } from "./viewport"
import { paneWrapLayoutFor, wrapBodyRows } from "./display-wrap"
import { computeLineVisualRows, syncViewportStartLine, visibleLineCountForBudget } from "./visual-line-height"
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
  const areaLines = Math.max(2, contentAreaLines(viewport.rows) - completionLines - logical.overlayRows)
  const windows = layoutWindowTree(logical, logical.windows, areaLines, viewport.cols, hostCapabilities)
  const childFrames = logical.childFrames.map(frame => layoutChildFrame(logical, frame, viewport, hostCapabilities))

  return {
    title: logical.title,
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
  const maxLines = windowBodyLines(availableLines)
  if (!pane.buffer) {
    return {
      id: leaf.id,
      bufferId: pane.bufferId,
      selected: pane.selected,
      dedicated: leaf.dedicated,
      body: plainThemedText(""),
      terminalSurface: undefined,
      modeline: pane.modeline,
      clickState: { startLine: 0, gutterPrefixLen: 0 },
      bodyLineBudget: maxLines,
      syncText: "",
      syncPoint: 0,
      syncSpans: [],
      textScale: 1,
    }
  }

  const surface = activeTerminalSurface(pane.terminalSurface, maxLines, availableCols)
  if (surface) {
    const useRaw = hostCapabilities?.terminalRawStreams
    return {
      id: leaf.id,
      bufferId: pane.bufferId,
      selected: pane.selected,
      dedicated: leaf.dedicated,
      body: useRaw ? plainThemedText("") : terminalSurfaceToThemedText(surface),
      terminalSurface: useRaw ? terminalSurfaceMetadata(surface) : surface,
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
  const dLines = dText.split("\n")
  const lineCount = dLines.length
  let startLine = Math.max(0, Math.min(pane.startLine, lineCount - 1))
  const wrapLayout = paneWrapLayoutFor(
    dText,
    pane.locals,
    availableCols,
    pane.showLineNumbers,
    startLine,
    maxLines,
  )
  const useVisualWeights = hostCapabilities?.perFaceFonts === true
  const visualRows = useVisualWeights
    ? computeLineVisualRows(dText, dFontLockSpans, logical.theme, pane.buffer, pane.textScale, {
      wrapCols: wrapLayout.wrapCols,
      gutterPrefixLen: wrapLayout.gutterPrefixLen,
      wordWrap: wrapLayout.wordWrap,
      displayLines: dLines,
    })
    : undefined
  if (pane.selected) {
    // Keep point on-screen — same correction the shim wrote back to the editor.
    const cursorLine = pointLineCol(dText, dPoint).line - 1
    startLine = syncViewportStartLine(startLine, cursorLine, maxLines, visualRows)
  }
  const displayLines = visualRows
    ? visibleLineCountForBudget(startLine, maxLines, lineCount, visualRows)
    : maxLines
  const syncSpans = bufferHighlightSpans(pane.point, mark, pane.spans)
  const clickState = windowClickState(dText, startLine, displayLines, pane.showLineNumbers)
  if (pane.displayUnmap) clickState.displayToBuffer = pane.displayUnmap
  // Hosts hard-wrap overflowing rows at column 0, which paints continuation
  // text into the next line's gutter (t-16be1a86). Pre-wrap here so every
  // continuation row carries the gutter's left padding.
  const keepWrappedTop = startLine === 0
  const { wrapCols, gutterPrefixLen: gutter, wordWrap } = paneWrapLayoutFor(
    dText,
    pane.locals,
    availableCols,
    pane.showLineNumbers,
    startLine,
    displayLines,
  )
  const visualFill = visualFillSettings(pane.locals)
  const contentWidth = availableCols != null
    ? Math.max(1, availableCols - clickState.gutterPrefixLen)
    : undefined
  const columnWidth = visualFill && contentWidth != null && wrapCols != null
    ? wrapCols - clickState.gutterPrefixLen
    : undefined
  let body = wrapBodyRows(
    visibleStyledTextFromStart(dText, dPoint, startLine, {
      mark: dMark,
      spans: dSpans,
      theme: logical.theme,
      buffer: pane.buffer,
      maxLines: displayLines,
      showLineNumbers: pane.showLineNumbers,
      showCursor: pane.selected,
    }),
    wrapCols,
    gutter,
    maxLines,
    keepWrappedTop,
    wordWrap,
  )
  if (visualFill?.center && columnWidth != null && contentWidth != null && columnWidth < contentWidth) {
    const leftMargin = Math.floor((contentWidth - columnWidth) / 2)
    if (leftMargin > 0) {
      clickState.leftPadding = leftMargin
      body = padBodyLines(body, " ".repeat(leftMargin))
    }
  }

  return {
    id: leaf.id,
    bufferId: pane.bufferId,
    selected: pane.selected,
    dedicated: leaf.dedicated,
    body,
    terminalSurface: undefined,
    modeline: pane.modeline,
    clickState,
    bodyLineBudget: maxLines,
    syncText: pane.text,
    syncPoint: pane.point,
    syncSpans,
    textScale: pane.textScale,
  }
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
    if (end > start) spans.push({ start, end, face: "region" as const })
  }
  return applyTheme(text, spans, theme)
}

function themedMinibuffer(logical: LogicalModel, theme: Theme): ThemedText {
  const mb = logical.minibuffer
  if (!mb) return applyTheme(" ", [], theme)
  const input = textWithCursor(mb.text, mb.point)
  const minibufferText = mb.prompt + input
  return applyTheme(minibufferText, [
    { start: 0, end: mb.prompt.length, face: "minibufferPrompt" },
    { start: mb.prompt.length, end: minibufferText.length, face: "minibuffer" },
  ], theme)
}
