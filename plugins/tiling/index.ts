import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { defvar, getCustom, setCustom } from "../../src/runtime/custom"
import {
  balanceWindowTree,
  deleteOtherWindowLeaves,
  deleteWindowLeaf,
  findWindowLeaf,
  listWindowLeaves,
  setWindowLeafBuffer,
  setWindowLeafStartLine,
  splitWindowLeaf,
  type WindowNode,
} from "../../src/kernel/window"
import { windowInDirection, type Direction } from "../windmove"

const LAYOUTS = ["tiling-master-left", "tiling-master-top", "tiling-even-horizontal", "tiling-even-vertical", "tiling-tile-4"] as const

export type TilingLayoutName = typeof LAYOUTS[number]

defvar("tiling-layout", "tiling-master-left",
  "Current i3-style tiling layout name. `tiling-cycle` advances it and re-tiles the frame.")

export function tilingLayout(): string {
  return getCustom("tiling-layout") as string
}

export function tilingLayouts(): readonly TilingLayoutName[] {
  return LAYOUTS
}

/** One visible window's contents, in `window-list` order starting at the selected window. */
type Pane = { bufferId: string; point: number; startLine: number }

/** `(mapcar 'window-buffer (window-list nil -1 nil))` — selected window first, then cyclic order. */
function visiblePanes(editor: Editor): Pane[] {
  const leaves = listWindowLeaves(editor.windowLayout)
  const at = Math.max(0, leaves.findIndex(leaf => leaf.id === editor.selectedWindowId))
  const rotated = [...leaves.slice(at), ...leaves.slice(0, at)]
  return rotated.map(leaf => ({
    bufferId: leaf.bufferId,
    // The selected window's stored point lags the live buffer until the next persist.
    point: leaf.id === editor.selectedWindowId ? editor.currentBuffer.point : leaf.point,
    startLine: leaf.startLine,
  }))
}

type Placed = { tree: WindowNode; id: string }

/** `split-window-{horizontally,vertically}` + `set-window-buffer` on the new pane. */
function place(tree: WindowNode, targetId: string, direction: "horizontal" | "vertical", pane: Pane): Placed | null {
  const split = splitWindowLeaf(tree, targetId, direction, pane.bufferId, pane.point)
  if (!split.found) return null
  return { tree: setWindowLeafStartLine(split.layout, split.newWindowId, pane.startLine), id: split.newWindowId }
}

/**
 * `tiling-master`: one master pane takes half the frame, the rest stack across it.
 * horizontal=true puts the master on the left (`tiling-master-left`).
 */
function masterLayout(root: WindowNode, rootId: string, panes: Pane[], horizontal: boolean): WindowNode | null {
  const across = horizontal ? "vertical" : "horizontal"
  let placed = place(root, rootId, horizontal ? "horizontal" : "vertical", panes[1]!)
  if (!placed) return null
  // Each extra buffer splits the *previous* non-master pane, so the stack grows in order.
  for (const pane of panes.slice(2)) {
    const next = place(placed.tree, placed.id, across, pane)
    if (!next) return null
    placed = next
  }
  return placed.tree
}

/** `tiling-even`: chain-split every pane the same way, then balance for equal shares. */
function evenLayout(root: WindowNode, rootId: string, panes: Pane[], horizontal: boolean): WindowNode | null {
  let placed: Placed = { tree: root, id: rootId }
  for (const pane of panes.slice(1)) {
    const next = place(placed.tree, placed.id, horizontal ? "horizontal" : "vertical", pane)
    if (!next) return null
    placed = next
  }
  return placed.tree
}

/** `tiling-tile-4`: 2x2 grid; the Emacs original only applies to exactly four windows. */
function tile4Layout(root: WindowNode, rootId: string, panes: Pane[]): WindowNode | null {
  if (panes.length !== 4) return null
  const right = place(root, rootId, "horizontal", panes[1]!)
  if (!right) return null
  const bottomRight = place(right.tree, right.id, "vertical", panes[2]!)
  if (!bottomRight) return null
  const bottomLeft = place(bottomRight.tree, rootId, "vertical", panes[3]!)
  if (!bottomLeft) return null
  return bottomLeft.tree
}

function buildLayout(name: string, root: WindowNode, rootId: string, panes: Pane[]): WindowNode | null {
  switch (name) {
    case "tiling-master-left": return masterLayout(root, rootId, panes, true)
    case "tiling-master-top": return masterLayout(root, rootId, panes, false)
    case "tiling-even-horizontal": return evenLayout(root, rootId, panes, true)
    case "tiling-even-vertical": return evenLayout(root, rootId, panes, false)
    case "tiling-tile-4": return tile4Layout(root, rootId, panes)
    default: return null
  }
}

/**
 * Rebuild the frame in `name`, re-placing exactly the buffers that are visible now.
 *
 * Mirrors the layout functions in tiling.el: `delete-other-windows` from the selected
 * window, then split outwards placing each buffer, then `balance-windows`. The selected
 * window keeps its id and its buffer, so the selection survives the re-tile.
 *
 * Returns false (frame untouched) when the layout does not apply: fewer than two
 * windows, or `tiling-tile-4` on a frame that is not exactly four windows.
 */
export function applyTilingLayout(editor: Editor, name: string = tilingLayout()): boolean {
  const panes = visiblePanes(editor)
  if (panes.length < 2) return false
  const rootId = editor.selectedWindowId
  if (!findWindowLeaf(editor.windowLayout, rootId)) return false

  let applied = false
  editor.mutateWindowLayout(current => {
    if (!findWindowLeaf(current, rootId)) return current
    // `delete-other-windows` first: every later split ratio is computed against the
    // rebuilt tree, not the one we are replacing.
    const solo = setWindowLeafBuffer(deleteOtherWindowLeaves(current, rootId), rootId, panes[0]!.bufferId, panes[0]!.point)
    const base = setWindowLeafStartLine(solo, rootId, panes[0]!.startLine)
    const built = buildLayout(name, base, rootId, panes)
    if (!built) return current
    applied = true
    return balanceWindowTree(built)
  }, "tiling-cycle")
  return applied
}

/**
 * `tiling-cycle`: advance to the next layout and apply it.
 *
 * With a single window there is nothing to tile (as in Emacs, where `tiling-cycle`
 * bails when fewer than two buffers are shown), but the name still advances so
 * repeated presses are not stuck on one layout.
 */
export function cycleTilingLayout(editor: Editor): string {
  const cur = tilingLayout()
  const next = LAYOUTS[(LAYOUTS.indexOf(cur as TilingLayoutName) + 1) % LAYOUTS.length]!
  setCustom("tiling-layout", next)
  if (!applyTilingLayout(editor, next)) void editor.changed("tiling-cycle")
  return next
}

/**
 * Move the current buffer into the window in `dir`, as `tiling-tile-move` does in Emacs.
 *
 * The Emacs original deletes the source window, selects the neighbour, splits it
 * *across* the direction of travel (moving up/down splits horizontally, left/right
 * splits vertically) and shows the buffer in the new pane. Reproduced here with the
 * kernel's layout primitives.
 *
 * Returns false when there is no neighbour in that direction, leaving the layout alone.
 */
export function tileMove(editor: Editor, dir: Direction): boolean {
  const sourceId = editor.selectedWindowId
  const targetId = windowInDirection(editor.windowLayout, sourceId, dir)
  if (!targetId || targetId === sourceId) return false

  const source = findWindowLeaf(editor.windowLayout, sourceId)
  if (!source) return false
  const bufferId = source.bufferId
  const point = source.point

  // Up/down travel splits the destination horizontally; left/right splits it vertically,
  // matching `tiling-tile-move`.
  const direction = dir === "up" || dir === "down" ? "horizontal" : "vertical"

  // Delete the source window *before* splitting: splitting first would compute ratios
  // against a tree that still contains the pane we are about to remove.
  let landedId: string | null = null
  editor.mutateWindowLayout(current => {
    const pruned = deleteWindowLeaf(current, sourceId)
    if (!pruned || !findWindowLeaf(pruned, targetId)) return current
    const split = splitWindowLeaf(pruned, targetId, direction, bufferId, point)
    if (!split.found) return current
    landedId = split.newWindowId
    // tiling.el balances both after the delete and after the split; balancing the
    // final tree once is equivalent, since balanceWindowTree only reads leaf counts.
    return balanceWindowTree(split.layout)
  }, "tiling-tile-" + dir)

  if (!landedId) return false
  editor.selectWindow(landedId)
  void editor.changed("tiling-tile-" + dir)
  return true
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  editor.command("tiling-cycle", ({ editor }) => editor.message(`Layout ${cycleTilingLayout(editor)}`),
    "Cycle i3-style tiling layouts, re-tiling the frame with the currently visible buffers.")

  editor.command("tiling-apply-layout", ({ editor, args }) => {
    const name = typeof args[0] === "string" && args[0] ? args[0] : tilingLayout()
    if (!applyTilingLayout(editor, name)) editor.message(`Layout ${name} does not apply here`)
  }, "Re-tile the frame with a named tiling layout, keeping the visible buffers.")

  const directions: Direction[] = ["up", "down", "left", "right"]
  for (const dir of directions) {
    editor.command(`tiling-tile-${dir}`, ({ editor }) => {
      if (!tileMove(editor, dir)) editor.message(`No window ${dir} from selected window`)
    }, `Move the current buffer into the window ${dir} of this one.`)
  }

  editor.key("C-\\", "tiling-cycle")
  editor.key("C-M-up", "tiling-tile-up")
  editor.key("C-M-down", "tiling-tile-down")
  editor.key("C-M-left", "tiling-tile-left")
  editor.key("C-M-right", "tiling-tile-right")
}
