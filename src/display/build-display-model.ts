import type { Editor } from "../kernel/editor"
import type { BufferModel } from "../kernel/buffer"
import type { HostCapabilities } from "./protocol"
import type { DisplayModel } from "./protocol"
import { contentAreaLines, windowBodyLines, type ViewportSize } from "./viewport"
import { setEditorDisplayContext } from "./scroll"
import { paneWrapLayoutFor } from "./display-wrap"
import { computeLineVisualRows, visualRowLineRange } from "./visual-line-height"
import { buildLogicalModel, pointLineCol, type LogicalPane, type LogicalWindowNode } from "./logical"
import { layoutCharGrid, splitColBudget, splitLineBudget } from "./char-grid-layout"

export type BuildDisplayOptions = {
  lastMessage?: string
  viewport: ViewportSize
  hostLabel?: string
  hostCapabilities?: HostCapabilities
}

/** `Editor` → `DisplayModel` for char-grid hosts (OpenTUI / Electron).
 *  Shim: editor side-effects + `buildLogicalModel` → `layoutCharGrid`. */
export function buildDisplayModel(editor: Editor, options: BuildDisplayOptions): DisplayModel {
  const { viewport, lastMessage, hostLabel, hostCapabilities } = options
  setEditorDisplayContext(editor, viewport, hostCapabilities)
  const logical = buildLogicalModel(editor, { lastMessage, hostLabel })
  const selected = syncEditorWindowGeometry(editor, logical, viewport)
  const model = layoutCharGrid(logical, viewport, hostCapabilities)
  // Write the selected window's corrected `startLine` back to the editor.
  // `layoutCharGrid` derives the same value internally for rendering; this is
  // the persistence half so the next frame / scroll command sees it. Runs
  // *after* the logical build so `LogicalPane.startLine` matches the wrap
  // input the legacy path used for visual-row weighting.
  if (selected) {
    const visualRows = hostCapabilities?.perFaceFonts === true
      ? selectedVisualRows(editor, selected.pane, selected.maxLines, selected.cols)
      : undefined
    editor.syncSelectedWindowViewport(selected.maxLines, visualRows)
  }
  return model
}

type SelectedLeaf = { pane: LogicalPane; maxLines: number; cols?: number }

/** Walk the logical window tree with the same row/col split as `layoutCharGrid`
 *  and stamp each leaf's body geometry onto its own `pane.locals` snapshot, so
 *  every split sees the dimensions it will actually render with. The live
 *  `buffer.locals` is updated once per buffer (selected window's geometry wins)
 *  for `window-configuration-change-hook` consumers like terminal panes.
 *  Returns the selected leaf for the post-layout viewport sync. */
function syncEditorWindowGeometry(
  editor: Editor,
  logical: ReturnType<typeof buildLogicalModel>,
  viewport: ViewportSize,
): SelectedLeaf | null {
  const completionLines = logical.completion?.text
    ? Math.max(1, logical.completion.text.split("\n").length)
    : 0
  const areaLines = Math.max(2, contentAreaLines(viewport.rows) - completionLines - logical.overlayRows)
  let selected: SelectedLeaf | null = null
  const published = new Set<string>()
  walk(logical.windows, areaLines, viewport.cols)
  return selected

  function walk(node: LogicalWindowNode, lines: number, cols?: number): void {
    if (node.kind === "leaf") {
      const { pane } = node
      const maxLines = windowBodyLines(lines)
      const isSelected = node.id === logical.selectedWindowId
      stampPaneGeometry(pane, maxLines, cols, viewport.cols)
      // Per-buffer side effect: selected window's geometry takes precedence so
      // a non-selected split walked later cannot overwrite it (t-audit2-fb76fc34).
      if (isSelected || !published.has(pane.bufferId)) {
        published.add(pane.bufferId)
        const buffer = editor.buffers.get(pane.bufferId)
        if (buffer) syncWindowBodyGeometry(editor, buffer, maxLines, cols ?? viewport.cols)
      }
      if (isSelected) selected = { pane, maxLines, cols }
      return
    }
    const lb = splitLineBudget(lines, node.direction, node.ratio)
    const cb = splitColBudget(cols, node.direction, node.ratio)
    walk(node.first, lb.first, cb.first)
    walk(node.second, lb.second, cb.second)
  }
}

/** Write this leaf's body geometry into the per-pane locals snapshot so
 *  downstream layout / serialization see per-window dimensions, independent of
 *  the buffer-level publish (t-audit2-d032ccb4). */
function stampPaneGeometry(pane: LogicalPane, rows: number, cols: number | undefined, fallbackCols?: number): void {
  if (!pane.buffer) return
  const locals = pane.locals as Map<string, unknown>
  locals.set("window-body-rows", Math.max(1, rows))
  locals.set("window-body-cols", Math.max(1, cols ?? fallbackCols ?? 80))
}

function selectedVisualRows(editor: Editor, pane: LogicalPane, maxLines: number, cols?: number): number[] | undefined {
  if (!pane.buffer) return undefined
  const dText = pane.displayText
  const map = pane.displayMap
  const dPoint = map ? map(pane.point) : pane.point
  const cursorLine = pointLineCol(dText, dPoint).line - 1
  const displayLines = dText.split("\n")
  const lineRange = visualRowLineRange(pane.startLine, cursorLine, maxLines, displayLines.length)
  const dFontLockSpans = map
    ? pane.fontLockSpans.map(s => ({ ...s, start: map(s.start), end: map(s.end) }))
    : pane.fontLockSpans
  const wrapLayout = paneWrapLayoutFor(dText, pane.locals, cols, pane.showLineNumbers, pane.startLine, maxLines)
  return computeLineVisualRows(dText, dFontLockSpans, editor.theme, pane.buffer, pane.textScale, {
    wrapCols: wrapLayout.wrapCols,
    gutterPrefixLen: wrapLayout.gutterPrefixLen,
    wordWrap: wrapLayout.wordWrap,
    displayLines,
    fromLine: lineRange.fromLine,
    toLine: lineRange.toLine,
  })
}

function syncWindowBodyGeometry(editor: Editor, buffer: BufferModel, rows: number, cols?: number): void {
  const safeRows = Math.max(1, rows)
  const safeCols = Math.max(1, cols ?? 80)
  const oldRows = buffer.locals.get("window-body-rows")
  const oldCols = buffer.locals.get("window-body-cols")
  if (oldRows === safeRows && oldCols === safeCols) return
  buffer.locals.set("window-body-rows", safeRows)
  buffer.locals.set("window-body-cols", safeCols)
  void editor.runHook("window-configuration-change-hook", buffer)
}

export { buildLogicalModel } from "./logical"
export { layoutCharGrid } from "./char-grid-layout"
