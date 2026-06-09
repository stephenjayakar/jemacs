import type { LogicalModel, LogicalPane, LogicalWindowNode } from "../display/logical"
import { pointLineCol } from "../display/logical"
import type {
  SerializedDisplayModel,
  SerializedPane,
  SerializedThemedText,
  SerializedWindowNode,
} from "../display/serialize"
import { serializeThemedText } from "../display/serialize"
import { applyTheme } from "../display/theme"
import type { ViewportSize } from "../display/viewport"
import { textWithCursor } from "../ui/text-display"
import type { TextSpan } from "../modes/mode"

/** Project a `LogicalModel` straight to the wire model without char-grid
 *  wrapping. Each pane body is the full themed buffer text; the browser owns
 *  line wrapping (`white-space: pre-wrap`) and we ship a `cursor` coordinate
 *  instead of inserting a █ glyph — so variable-pitch faces lay out correctly. */
export function webLayout(logical: LogicalModel, viewport: ViewportSize = { rows: 0 }): SerializedDisplayModel {
  return {
    title: serializeThemedText(logical.title),
    windows: layoutNode(logical, logical.windows),
    minibufferCompletions: themedCompletions(logical),
    minibufferCompletionLines: logical.completion?.text
      ? Math.max(1, logical.completion.text.split("\n").length)
      : 0,
    minibuffer: themedMinibuffer(logical),
    echo: serializeThemedText(logical.echo),
    theme: logical.theme,
    viewport,
    hostLabel: logical.hostLabel,
  }
}

function layoutNode(logical: LogicalModel, node: LogicalWindowNode): SerializedWindowNode {
  if (node.kind === "leaf") {
    return { kind: "leaf", pane: layoutPane(logical, node.id, node.pane, node.dedicated) }
  }
  return {
    kind: "split",
    direction: node.direction,
    firstRatio: node.ratio,
    first: layoutNode(logical, node.first),
    second: layoutNode(logical, node.second),
  }
}

function layoutPane(logical: LogicalModel, id: string, pane: LogicalPane, dedicated: boolean): SerializedPane {
  const map = pane.displayMap
  const dPoint = map ? map(pane.point) : pane.point
  const mark = pane.markActive ? pane.mark : null
  const dMark = map && mark != null ? map(mark) : mark
  const dSpans = map ? pane.spans.map(s => ({ ...s, start: map(s.start), end: map(s.end) })) : pane.spans
  const allSpans: TextSpan[] = dMark == null || dMark === dPoint
    ? dSpans
    : [...dSpans, { start: Math.min(dMark, dPoint), end: Math.max(dMark, dPoint), face: "region" }]
  const body = serializeThemedText(
    applyTheme(pane.displayText, allSpans, logical.theme, { buffer: pane.buffer }),
  )
  const { line, col } = pointLineCol(pane.displayText, dPoint)
  return {
    id,
    bufferId: pane.bufferId,
    selected: pane.selected,
    dedicated,
    body,
    cursor: pane.selected ? { row: line - 1, colOffset: col - 1 } : undefined,
    terminalSurface: pane.terminalSurface,
    modeline: serializeThemedText(pane.modeline),
    clickState: { startLine: 0, gutterPrefixLen: 0 },
    bodyLineBudget: 0,
    syncText: pane.text,
    syncPoint: pane.point,
    textScale: pane.textScale,
  }
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
