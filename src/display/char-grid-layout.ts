import type { MinibufferCompletionDisplay } from "../kernel/editor"
import { getCustom } from "../runtime/custom"
import type { HostCapabilities } from "./protocol"
import { textWithCursor } from "../ui/text-display"
import { windowClickState } from "./click-to-point"
import { visibleStyledTextFromStart } from "./buffer-view"
import type { DisplayModel, WindowDisplayNode, WindowPaneModel } from "./protocol"
import { bufferHighlightSpans } from "./buffer-highlights"
import { applyTheme, type Theme } from "./theme"
import { terminalSurfaceToThemedText, type TerminalSurfaceModel } from "./terminal-surface"
import { plainThemedText, type ThemedChunk, type ThemedText } from "./themed-text"
import { contentAreaLines, windowBodyLines, type ViewportSize } from "./viewport"
import { paneWrapLayoutFor, wrapBodyRows } from "./display-wrap"
import { computeLineVisualRows, syncViewportStartLine, visibleLineCountForBudget } from "./visual-line-height"
import type { LogicalModel, LogicalPane, LogicalWindowNode } from "./logical"
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

  return {
    title: logical.title,
    windows,
    minibufferCompletions: themedCompletions(logical.completion, logical.theme),
    minibufferCompletionLines: completionLines,
    minibuffer: themedMinibuffer(logical, logical.theme),
    echo: logical.echo,
    theme: logical.theme,
    viewport,
    hostLabel: logical.hostLabel,
  }
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
      markdownSurface: undefined,
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
      markdownSurface: undefined,
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

  let startLine = pane.startLine
  const displayLinesForWrap = pane.displayText.split("\n")
  const wrapLayout = paneWrapLayoutFor(
    pane.displayText,
    pane.locals,
    availableCols,
    pane.showLineNumbers,
    startLine,
    maxLines,
  )
  const useVisualWeights = hostCapabilities?.perFaceFonts === true
  const visualRows = useVisualWeights
    ? computeLineVisualRows(pane.text, pane.fontLockSpans, logical.theme, pane.buffer, pane.textScale, {
      wrapCols: wrapLayout.wrapCols,
      gutterPrefixLen: wrapLayout.gutterPrefixLen,
      wordWrap: wrapLayout.wordWrap,
      displayLines: displayLinesForWrap,
    })
    : undefined
  if (pane.selected) {
    // Keep point on-screen — same correction the shim wrote back to the editor.
    const cursorLine = pointLineCol(pane.text, pane.point).line - 1
    startLine = syncViewportStartLine(startLine, cursorLine, maxLines, visualRows)
  }
  const lineCount = pane.text.split("\n").length
  const displayLines = visualRows
    ? visibleLineCountForBudget(startLine, maxLines, lineCount, visualRows)
    : maxLines
  const mark = pane.markActive ? pane.mark : null
  const syncSpans = bufferHighlightSpans(pane.point, mark, pane.spans)
  const map = pane.displayMap
  const dPoint = map ? map(pane.point) : pane.point
  const dMark = map && mark != null ? map(mark) : mark
  const dSpans = map ? pane.spans.map(s => ({ ...s, start: map(s.start), end: map(s.end) })) : pane.spans
  const clickState = windowClickState(pane.displayText, startLine, displayLines, pane.showLineNumbers)
  // Hosts hard-wrap overflowing rows at column 0, which paints continuation
  // text into the next line's gutter (t-16be1a86). Pre-wrap here so every
  // continuation row carries the gutter's left padding.
  const keepWrappedTop = startLine === 0
  const { wrapCols, gutterPrefixLen: gutter, wordWrap } = paneWrapLayoutFor(
    pane.displayText,
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
    visibleStyledTextFromStart(pane.displayText, dPoint, startLine, {
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
    if (leftMargin > 0) body = padBodyLines(body, " ".repeat(leftMargin))
  }

  return {
    id: leaf.id,
    bufferId: pane.bufferId,
    selected: pane.selected,
    dedicated: leaf.dedicated,
    body,
    markdownSurface: activeMarkdownSurface(pane, startLine),
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

function activeMarkdownSurface(pane: LogicalPane, startLine: number) {
  if (pane.locals.get("opentui-markdown-renderer") !== true) return undefined
  if (pane.mode !== "opentui-markdown-mode" && pane.mode !== "opentui-gfm-mode") return undefined
  return {
    kind: "markdown" as const,
    content: foldedMarkdownContent(pane.text, pane.locals),
    startLine,
  }
}

function foldedMarkdownContent(text: string, locals: ReadonlyMap<string, unknown>): string {
  const ranges = locals.get("markdown-folded") as Array<[number, number]> | undefined
  if (!ranges?.length) return text
  const lines = text.split("\n")
  const hidden = new Uint8Array(lines.length)
  for (const [a, b] of ranges) {
    for (let line = Math.max(0, a); line <= b && line < lines.length; line++) hidden[line] = 1
  }
  const out: string[] = []
  for (let line = 0; line < lines.length; line++) {
    if (hidden[line]) continue
    out.push(lines[line]!)
    if (line + 1 < lines.length && hidden[line + 1]) out.push("...")
  }
  return out.join("\n")
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
  const pad: ThemedChunk = { text: leftPad }
  const out: ThemedChunk[] = [pad]
  const append = (style: ThemedChunk, ch: string) => {
    const last = out[out.length - 1]!
    if (last.text !== leftPad && themedChunkStyleEqual(last, style) && !last.text.endsWith("\n")) {
      last.text += ch
      return
    }
    out.push({ ...style, text: ch })
  }
  for (const chunk of body.chunks) {
    for (const ch of chunk.text) {
      if (ch === "\n") {
        append(chunk, ch)
        out.push(pad)
      } else {
        append(chunk, ch)
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
