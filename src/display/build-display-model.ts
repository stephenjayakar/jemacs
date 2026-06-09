import type { Editor } from "../kernel/editor"
import type { BufferModel } from "../kernel/buffer"
import { textScaleFactor } from "../core/text-scale"
import type { HostCapabilities } from "./protocol"
import { type WindowNode } from "../kernel/window"
import { modeFeature } from "../modes/mode"
import type { DisplayModel } from "./protocol"
import { contentAreaLines, windowBodyLines, type ViewportSize } from "./viewport"
import { setEditorDisplayContext } from "./scroll"
import { paneWrapLayout } from "./display-wrap"
import { computeLineVisualRows } from "./visual-line-height"
import { buildLogicalModel } from "./logical"
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
  const selectedBudget = syncEditorWindowGeometry(editor, viewport)
  const model = layoutCharGrid(
    buildLogicalModel(editor, { lastMessage, hostLabel }),
    viewport,
    hostCapabilities,
  )
  // Write the selected window's corrected `startLine` back to the editor.
  // `layoutCharGrid` derives the same value internally for rendering; this is
  // the persistence half so the next frame / scroll command sees it. Runs
  // *after* the logical build so `LogicalPane.startLine` matches the wrap
  // input the legacy path used for visual-row weighting.
  if (selectedBudget) {
    const visualRows = hostCapabilities?.perFaceFonts === true
      ? selectedVisualRows(editor, selectedBudget)
      : undefined
    editor.syncSelectedWindowViewport(selectedBudget.maxLines, visualRows)
  }
  return model
}

type LeafBudget = { maxLines: number; cols?: number }

/** Walk the window tree with the same row/col split as `layoutCharGrid` and
 *  publish each leaf's body geometry to `buffer.locals` (so terminal panes /
 *  `window-body-{rows,cols}` consumers see the new size, and the resize hook
 *  fires). Returns the selected leaf's budget for the post-layout viewport sync. */
function syncEditorWindowGeometry(editor: Editor, viewport: ViewportSize): LeafBudget | null {
  const completionText = editor.minibufferCompletionDisplay?.text
  const completionLines = completionText ? Math.max(1, completionText.split("\n").length) : 0
  const overlayRows = editor.minibuffer ? editor.activeBuffer.text.split("\n").length - 1 : 0
  const areaLines = Math.max(2, contentAreaLines(viewport.rows) - completionLines - overlayRows)
  let selected: LeafBudget | null = null
  walk(editor.windowLayout, areaLines, viewport.cols)
  return selected

  function walk(node: WindowNode, lines: number, cols?: number): void {
    if (node.kind === "leaf") {
      const buffer = editor.buffers.get(node.bufferId)
      if (!buffer) return
      const maxLines = windowBodyLines(lines)
      syncWindowBodyGeometry(editor, buffer, maxLines, cols)
      if (node.id === editor.selectedWindowId) selected = { maxLines, cols }
      return
    }
    const lb = splitLineBudget(lines, node.direction, node.firstRatio)
    const cb = splitColBudget(cols, node.direction, node.firstRatio)
    walk(node.first, lb.first, cb.first)
    walk(node.second, lb.second, cb.second)
  }
}

function selectedVisualRows(editor: Editor, budget: LeafBudget): number[] | undefined {
  const leaf = editor.selectedWindowLeaf()
  const buffer = leaf ? editor.buffers.get(leaf.bufferId) : undefined
  if (!leaf || !buffer) return undefined
  const showLineNumbers = buffer.kind !== "minibuffer" && editor.showLineNumbers(buffer)
  const filt = modeFeature(buffer.mode, "displayFilter")?.(buffer)
  const wrapLayout = paneWrapLayout(buffer, budget.cols, showLineNumbers, leaf.startLine, budget.maxLines)
  return computeLineVisualRows(buffer.text, [...editor.fontLock(buffer)], editor.theme, buffer, textScaleFactor(buffer), {
    wrapCols: wrapLayout.wrapCols,
    gutterPrefixLen: wrapLayout.gutterPrefixLen,
    wordWrap: wrapLayout.wordWrap,
    displayLines: (filt?.text ?? buffer.text).split("\n"),
  })
}

function syncWindowBodyGeometry(editor: Editor, buffer: BufferModel, rows: number, cols?: number): void {
  const safeRows = Math.max(1, rows)
  const safeCols = Math.max(1, cols ?? editor.lastViewport?.cols ?? 80)
  const oldRows = buffer.locals.get("window-body-rows")
  const oldCols = buffer.locals.get("window-body-cols")
  if (oldRows === safeRows && oldCols === safeCols) return
  buffer.locals.set("window-body-rows", safeRows)
  buffer.locals.set("window-body-cols", safeCols)
  void editor.runHook("window-configuration-change-hook", buffer)
}

export { buildLogicalModel } from "./logical"
export { layoutCharGrid } from "./char-grid-layout"
