import { splitLineBudget } from "../display/char-grid-layout"
import type { LogicalModel, LogicalPane, LogicalWindowNode } from "../display/logical"
import { pointLineCol } from "../display/logical"
import type {
  SerializedDisplayModel,
  SerializedChildFrame,
  SerializedPane,
  SerializedThemedText,
  SerializedWindowNode,
} from "../display/serialize"
import { serializeThemedText } from "../display/serialize"
import { applyTheme } from "../display/theme"
import { contentAreaLines, visibleTextRegionFromStart, windowBodyLines, type ViewportSize } from "../display/viewport"
import { textWithCursor } from "../ui/text-display"
import type { TextSpan } from "../modes/mode"

/** Row budget when the caller passes no viewport (browser-shadow path renders
 *  in-process, so this bounds DOM cost rather than wire cost). */
const FALLBACK_ROWS = 48

/** Project a `LogicalModel` straight to the wire model without char-grid
 *  wrapping. Each pane body is the themed buffer text **for the visible
 *  viewport only** (t-audit2-d91a6e9f); the browser owns line wrapping
 *  (`white-space: pre-wrap`) and we ship a `cursor` coordinate instead of
 *  inserting a █ glyph — so variable-pitch faces lay out correctly. */
export function webLayout(logical: LogicalModel, viewport: ViewportSize = { rows: 0 }): SerializedDisplayModel {
  const completionLines = logical.completion?.text
    ? Math.max(1, logical.completion.text.split("\n").length)
    : 0
  const rows = viewport.rows > 0 ? viewport.rows : FALLBACK_ROWS
  const areaLines = Math.max(2, contentAreaLines(rows) - completionLines - logical.overlayRows)
  return {
    title: serializeThemedText(logical.title),
    windows: layoutNode(logical, logical.windows, areaLines),
    childFrames: logical.childFrames.map(frame => layoutChildFrame(logical, frame)),
    minibufferCompletions: themedCompletions(logical),
    minibufferCompletionLines: completionLines,
    minibuffer: themedMinibuffer(logical),
    echo: serializeThemedText(logical.echo),
    theme: logical.theme,
    viewport,
    hostLabel: logical.hostLabel,
  }
}

function layoutChildFrame(logical: LogicalModel, frame: LogicalModel["childFrames"][number]): SerializedChildFrame {
  const height = typeof frame.parameters.height === "number" ? frame.parameters.height : 12
  return {
    id: frame.id,
    parentFrameId: frame.parentFrameId,
    pane: layoutPane(logical, `${frame.id}:window`, frame.pane, true, windowBodyLines(height)),
    top: typeof frame.parameters.top === "number" ? frame.parameters.top : 2,
    left: typeof frame.parameters.left === "number" ? frame.parameters.left : 2,
    width: typeof frame.parameters.width === "number" ? frame.parameters.width : 72,
    height,
  }
}

function layoutNode(logical: LogicalModel, node: LogicalWindowNode, availableLines: number): SerializedWindowNode {
  if (node.kind === "leaf") {
    const bodyAndFooterLines = windowBodyLines(availableLines)
    const footerLines = footerLineCount(node.pane.footer?.text, bodyAndFooterLines)
    return {
      kind: "leaf",
      pane: layoutPane(logical, node.id, node.pane, node.dedicated, Math.max(1, bodyAndFooterLines - footerLines)),
    }
  }
  const lines = splitLineBudget(availableLines, node.direction, node.ratio)
  return {
    kind: "split",
    direction: node.direction,
    firstRatio: node.ratio,
    first: layoutNode(logical, node.first, lines.first),
    second: layoutNode(logical, node.second, lines.second),
  }
}

function layoutPane(
  logical: LogicalModel,
  id: string,
  pane: LogicalPane,
  dedicated: boolean,
  maxLines: number,
): SerializedPane {
  const map = pane.displayMap
  const dPoint = map ? map(pane.point) : pane.point
  const mark = pane.markActive ? pane.mark : null
  const dMark = map && mark != null ? map(mark) : mark
  const dSpans = map ? pane.spans.map(s => ({ ...s, start: map(s.start), end: map(s.end) })) : pane.spans
  const allSpans: TextSpan[] = dMark == null || dMark === dPoint
    ? dSpans
    : [...dSpans, { start: Math.min(dMark, dPoint), end: Math.max(dMark, dPoint), face: "region" }]

  // Keep point on screen — same correction `layoutCharGrid` applies, sans
  // visual-row weighting (the browser owns wrapping).
  const { line, col } = pointLineCol(pane.displayText, dPoint)
  const cursorLine = line - 1
  const startLine = pane.selected
    ? Math.max(Math.min(pane.startLine, cursorLine), cursorLine - maxLines + 1)
    : pane.startLine

  const { visible, visibleStart } = visibleTextRegionFromStart(pane.displayText, startLine, maxLines)
  const visibleEnd = visibleStart + visible.length
  const visibleSpans = allSpans
    .filter(s => s.end > visibleStart && s.start < visibleEnd)
    .map(s => ({
      ...s,
      start: Math.max(0, s.start - visibleStart),
      end: Math.min(visible.length, s.end - visibleStart),
    }))
  const body = serializeThemedText(
    applyTheme(visible, visibleSpans, logical.theme, { buffer: pane.buffer }),
  )
  return {
    id,
    bufferId: pane.bufferId,
    selected: pane.selected,
    dedicated,
    body,
    cursor: pane.selected ? { row: cursorLine - startLine, colOffset: col - 1 } : undefined,
    terminalSurface: pane.terminalSurface,
    footer: pane.footer?.text ? serializeThemedText(applyTheme(pane.footer.text, pane.footer.spans ?? [], logical.theme)) : undefined,
    modeline: serializeThemedText(pane.modeline),
    clickState: { startLine, gutterPrefixLen: 0 },
    bodyLineBudget: maxLines,
    // Web hosts render `body` directly; the OpenTUI Textarea sync path is the
    // only `syncText` consumer and never sees this model.
    syncText: "",
    syncPoint: 0,
    textScale: pane.textScale,
  }
}

function footerLineCount(text: string | undefined, bodyAndFooterLines: number): number {
  if (!text) return 0
  return Math.min(Math.max(0, bodyAndFooterLines - 1), Math.max(1, text.split("\n").length))
}

function themedCompletions(logical: LogicalModel): SerializedThemedText {
  const display = logical.completion
  if (!display?.text) return serializeThemedText(applyTheme("", [], logical.theme))
  const text = display.text
  const spans: TextSpan[] = []
  if (display.selectedLine != null) {
    const lines = text.split("\n")
    let start = 0
    for (let i = 0; i < Math.min(display.selectedLine, lines.length); i++) start += lines[i]!.length + 1
    const end = start + (lines[display.selectedLine]?.length ?? 0)
    if (end > start) spans.push({ start, end, face: "region" })
  }
  return serializeThemedText(applyTheme(text, spans, logical.theme))
}

function themedMinibuffer(logical: LogicalModel): SerializedThemedText {
  const mb = logical.minibuffer
  if (!mb) return serializeThemedText(applyTheme(" ", [], logical.theme))
  const input = textWithCursor(mb.text, mb.point)
  const text = mb.prompt + input
  return serializeThemedText(applyTheme(text, [
    { start: 0, end: mb.prompt.length, face: "minibufferPrompt" },
    { start: mb.prompt.length, end: text.length, face: "minibuffer" },
  ], logical.theme))
}
