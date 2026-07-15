import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { BufferModel, type SerializedUndoTree, type UndoTreeNodeView } from "../../src/kernel/buffer"
import type { Editor } from "../../src/kernel/editor"
import { Keymap } from "../../src/kernel/keymap"
import { defineMode, type FaceName, type TextSpan } from "../../src/modes/mode"
import { defcustom, getCustom } from "../../src/runtime/custom"
import { defface } from "../../src/runtime/faces"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { listWindowLeaves } from "../../src/kernel/window"

const VISUALIZER_STATE = "undo-tree-visualizer-state"
const VISUALIZER_SPANS = "undo-tree-visualizer-spans"
const VISUALIZER_NODE_RANGES = "undo-tree-visualizer-node-ranges"

type VisualizerState = {
  parentBufferId: string
  openedAtNodeId: number
  showTimestamps: boolean
  showDiff: boolean
}

type RenderedNode = {
  node: UndoTreeNodeView
  x: number
  y: number
  label: string
  active: boolean
}

type RenderedTree = {
  text: string
  spans: TextSpan[]
  nodeRanges: Array<{ start: number; end: number; nodeId: number }>
  currentPoint: number
}

const FACE_DEFAULT = "undo-tree-visualizer-default-face" as FaceName
const FACE_CURRENT = "undo-tree-visualizer-current-face" as FaceName
const FACE_ACTIVE = "undo-tree-visualizer-active-branch-face" as FaceName

defcustom("undo-tree-visualizer-timestamps", "boolean", false,
  "When non-nil, undo-tree visualizer nodes display timestamps.")
defcustom("undo-tree-auto-save-history", "boolean", true,
  "When non-nil, save undo-tree history for file buffers after saving.")
defcustom("undo-tree-history-directory", "string", join(homedir(), ".jemacs", "undo-tree-history"),
  "Directory where undo-tree history files are stored.")

defface("undo-tree-visualizer-default-face", { inherit: ["default"] }, "Face for undo-tree visualizer nodes.")
defface("undo-tree-visualizer-current-face", { fg: "#ff5f5f", bold: true }, "Face for the current undo-tree node.")
defface("undo-tree-visualizer-active-branch-face", { bold: true }, "Face for the active undo-tree branch.")

function currentNodeId(buffer: BufferModel): number {
  return buffer.undoTreeSnapshot().current.id
}

function didMoveUndo(buffer: BufferModel, fn: () => void): boolean {
  const beforeId = currentNodeId(buffer)
  const beforeText = buffer.text
  fn()
  return currentNodeId(buffer) !== beforeId || buffer.text !== beforeText
}

function visualizerState(buffer: BufferModel): VisualizerState | null {
  return (buffer.locals.get(VISUALIZER_STATE) as VisualizerState | undefined) ?? null
}

function findParent(root: UndoTreeNodeView, id: number): UndoTreeNodeView | null {
  for (const child of root.children) {
    if (child.id === id) return root
    const found = findParent(child, id)
    if (found) return found
  }
  return null
}

function activePathIds(root: UndoTreeNodeView): Set<number> {
  const ids = new Set<number>()
  for (let node: UndoTreeNodeView | undefined = root; node;) {
    ids.add(node.id)
    node = node.children[node.activeChild]
  }
  return ids
}

function timestamp(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function nodeLabel(node: UndoTreeNodeView, showTimestamps: boolean): string {
  if (showTimestamps) return timestamp(node.at)
  if (node.current) return "x"
  if (node.saved) return "s"
  return "o"
}

function setChar(grid: string[][], y: number, x: number, ch: string): void {
  if (y < 0 || x < 0) return
  while (grid.length <= y) grid.push([])
  grid[y]![x] = ch
}

function drawText(grid: string[][], y: number, x: number, text: string): void {
  for (let i = 0; i < text.length; i++) setChar(grid, y, x + i, text[i]!)
}

function measure(node: UndoTreeNodeView, showTimestamps: boolean): number {
  const labelWidth = nodeLabel(node, showTimestamps).length
  if (!node.children.length) return labelWidth
  return Math.max(labelWidth, node.children.reduce((sum, child) => sum + measure(child, showTimestamps) + 2, -2))
}

function layoutTree(
  node: UndoTreeNodeView,
  left: number,
  depth: number,
  showTimestamps: boolean,
  activeIds: Set<number>,
  out: RenderedNode[],
): number {
  const width = measure(node, showTimestamps)
  let center = left + Math.floor(width / 2)
  if (node.children.length) {
    let childLeft = left
    const childCenters: number[] = []
    for (const child of node.children) {
      const childCenter = layoutTree(child, childLeft, depth + 1, showTimestamps, activeIds, out)
      childCenters.push(childCenter)
      childLeft += measure(child, showTimestamps) + 2
    }
    center = Math.floor((childCenters[0]! + childCenters[childCenters.length - 1]!) / 2)
  }
  out.push({ node, x: center, y: depth * 2, label: nodeLabel(node, showTimestamps), active: activeIds.has(node.id) })
  return center
}

function renderTree(root: UndoTreeNodeView, showTimestamps: boolean): RenderedTree {
  const nodes: RenderedNode[] = []
  layoutTree(root, 0, 0, showTimestamps, activePathIds(root), nodes)
  const grid: string[][] = []
  for (const item of nodes) drawText(grid, item.y, item.x - Math.floor(item.label.length / 2), item.label)
  for (const item of nodes) {
    if (!item.node.children.length) continue
    const childItems = item.node.children.map(child => nodes.find(n => n.node.id === child.id)!).filter(Boolean)
    const y = item.y + 1
    for (const child of childItems) {
      const from = item.x
      const to = child.x
      const lo = Math.min(from, to)
      const hi = Math.max(from, to)
      for (let x = lo + 1; x < hi; x++) setChar(grid, y, x, "_")
      setChar(grid, y, from, "|")
      if (to < from) setChar(grid, y, to, "/")
      else if (to > from) setChar(grid, y, to, "\\")
      else setChar(grid, y, to, "|")
    }
  }

  const lines = grid.map(row => {
    const end = row.reduce((last, ch, i) => ch ? i : last, -1)
    return Array.from({ length: end + 1 }, (_, i) => row[i] ?? " ").join("")
  })
  const text = lines.join("\n") + "\n"
  const lineStarts: number[] = []
  let offset = 0
  for (const line of lines) {
    lineStarts.push(offset)
    offset += line.length + 1
  }
  const spans: TextSpan[] = []
  const nodeRanges: RenderedTree["nodeRanges"] = []
  let currentPoint = 0
  for (const item of nodes) {
    const start = lineStarts[item.y]! + item.x - Math.floor(item.label.length / 2)
    const end = start + item.label.length
    nodeRanges.push({ start, end, nodeId: item.node.id })
    if (item.active) spans.push({ start, end, face: FACE_ACTIVE })
    spans.push({ start, end, face: item.node.current ? FACE_CURRENT : FACE_DEFAULT })
    if (item.node.current) currentPoint = start
  }
  return { text, spans, nodeRanges, currentPoint }
}

function undoTreeFontLock(buffer: BufferModel): TextSpan[] {
  return (buffer.locals.get(VISUALIZER_SPANS) as TextSpan[] | undefined) ?? []
}

function replaceReadOnly(buffer: BufferModel, text: string): void {
  const wasReadOnly = buffer.readOnly
  buffer.readOnly = false
  buffer.setText(text, false, false)
  buffer.readOnly = wasReadOnly
}

function invalidateFontLock(editor: Editor, buffer: BufferModel): void {
  (editor as unknown as { fontLockCache?: WeakMap<BufferModel, unknown> }).fontLockCache?.delete(buffer)
}

function visualizerName(parent: BufferModel): string {
  return `*undo-tree: ${parent.name}*`
}

function utilityBuffer(editor: Editor, name: string, text: string, mode: string): BufferModel {
  const existing = [...editor.buffers.values()].find(b => b.name === name)
  if (existing) {
    replaceReadOnly(existing, text)
    existing.mode = mode
    existing.kind = "scratch"
    return existing
  }
  return editor.addBuffer(new BufferModel({ name, text, kind: "scratch", mode }))
}

function renderVisualizer(editor: Editor, visualizer: BufferModel): boolean {
  const state = visualizerState(visualizer)
  const parent = state ? editor.buffers.get(state.parentBufferId) : undefined
  if (!state || !parent) {
    editor.killBuffer(visualizer.id)
    editor.message("Parent buffer is gone")
    return false
  }
  const rendered = renderTree(parent.undoTreeSnapshot().root, state.showTimestamps)
  visualizer.locals.set(VISUALIZER_SPANS, rendered.spans)
  visualizer.locals.set(VISUALIZER_NODE_RANGES, rendered.nodeRanges)
  replaceReadOnly(visualizer, rendered.text)
  const treeWidth = Math.max(1, ...rendered.text.split("\n").map(line => line.length))
  // The display layer's visual-fill locals work for any buffer. GNU
  // undo-tree uses the full visualizer window but centers the drawn tree.
  visualizer.locals.set("markdown-visual-fill-column-mode", true)
  visualizer.locals.set("markdown-visual-fill-column-center-text", true)
  visualizer.locals.set("markdown-fill-column", treeWidth)
  invalidateFontLock(editor, visualizer)
  visualizer.point = rendered.currentPoint
  visualizer.readOnly = true
  if (state.showDiff) renderDiff(editor, parent)
  return true
}

function simpleUnifiedDiff(before: string, after: string): string {
  const a = before.split("\n")
  const b = after.split("\n")
  const lines = ["--- parent", "+++ current", "@@ @@"]
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) {
      if (a[i] !== undefined) lines.push(` ${a[i]}`)
    } else {
      if (a[i] !== undefined) lines.push(`-${a[i]}`)
      if (b[i] !== undefined) lines.push(`+${b[i]}`)
    }
  }
  return lines.join("\n") + "\n"
}

function textAtNode(buffer: BufferModel, nodeId: number): string {
  const original = currentNodeId(buffer)
  buffer.undoToNode(nodeId)
  const text = buffer.text
  buffer.undoToNode(original)
  return text
}

function renderDiff(editor: Editor, parent: BufferModel): void {
  const snapshot = parent.undoTreeSnapshot()
  const node = snapshot.current
  const p = findParent(snapshot.root, node.id)
  const before = p ? textAtNode(parent, p.id) : ""
  const after = textAtNode(parent, node.id)
  const diff = simpleUnifiedDiff(before, after)
  const buf = utilityBuffer(editor, "*undo-tree Diff*", diff, "diff-mode")
  buf.readOnly = true
  editor.displayBufferInOtherWindow(buf.id, { select: false })
}

function parentFromVisualizer(editor: Editor, visualizer: BufferModel): BufferModel | null {
  const state = visualizerState(visualizer)
  const parent = state ? editor.buffers.get(state.parentBufferId) : undefined
  if (!state || !parent) {
    editor.killBuffer(visualizer.id)
    editor.message("Parent buffer is gone")
    return null
  }
  return parent
}

function rerenderCurrentVisualizer(editor: Editor, buffer: BufferModel): void {
  renderVisualizer(editor, buffer)
}

function visualizerNodeIdAtPoint(buffer: BufferModel, point: number): number | null {
  const ranges = buffer.locals.get(VISUALIZER_NODE_RANGES) as RenderedTree["nodeRanges"] | undefined
  return ranges?.find(range => point >= range.start && point < range.end)?.nodeId ?? null
}

function setParentToVisualizerPoint(editor: Editor, visualizer: BufferModel, point: number): boolean {
  const nodeId = visualizerNodeIdAtPoint(visualizer, point)
  if (nodeId == null) return false
  const parent = parentFromVisualizer(editor, visualizer)
  if (!parent) return true
  parent.undoToNode(nodeId)
  rerenderCurrentVisualizer(editor, visualizer)
  return true
}

function quitVisualizer(editor: Editor, buffer: BufferModel): void {
  const state = visualizerState(buffer)
  const parentId = state?.parentBufferId
  if (editor.currentBuffer.id === buffer.id && listWindowLeaves(editor.windowLayout).length > 1) {
    editor.deleteWindow()
  }
  editor.killBuffer(buffer.id)
  if (!parentId || !editor.buffers.has(parentId)) return
  const parentWindow = listWindowLeaves(editor.windowLayout).find(leaf => leaf.bufferId === parentId)
  if (parentWindow) editor.selectWindow(parentWindow.id)
  else editor.switchToBuffer(parentId)
}

function switchBranch(parent: BufferModel, delta: number): boolean {
  const snapshot = parent.undoTreeSnapshot()
  const node = snapshot.current
  if (node.children.length <= 1) return false
  const next = Math.max(0, Math.min(node.children.length - 1, node.activeChild + delta))
  parent.undoSetBranch(node.id, next)
  return true
}

function undoTreeEnabled(editor: Editor, buffer: BufferModel): boolean {
  return buffer.minorModes.has("undo-tree-mode") || editor.isMinorModeEnabled("global-undo-tree-mode", buffer)
}

function historyDirectory(): string {
  return getCustom<string>("undo-tree-history-directory") ?? join(homedir(), ".jemacs", "undo-tree-history")
}

function historyPath(buffer: BufferModel): string | null {
  if (buffer.kind !== "file" || !buffer.path) return null
  return join(historyDirectory(), resolve(buffer.path).replaceAll("/", "!") + ".json")
}

function historyEligible(editor: Editor, buffer: BufferModel): string | null {
  if (!undoTreeEnabled(editor, buffer)) return null
  return historyPath(buffer)
}

async function saveHistory(editor: Editor, buffer: BufferModel): Promise<boolean> {
  const file = historyEligible(editor, buffer)
  if (!file) return false
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(buffer.undoTreeSerialize()), "utf8")
  return true
}

async function loadHistory(editor: Editor, buffer: BufferModel): Promise<boolean> {
  const file = historyEligible(editor, buffer)
  if (!file) return false
  await access(file)
  const parsed = JSON.parse(await readFile(file, "utf8")) as unknown
  return buffer.undoTreeRestore(parsed as SerializedUndoTree)
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  const undoTreeMap = new Keymap("undo-tree-mode-map")
  undoTreeMap.bind("C-/", "undo-tree-undo")
  undoTreeMap.bind("C-_", "undo-tree-undo")
  undoTreeMap.bind("M-_", "undo-tree-redo")
  undoTreeMap.bind("C-?", "undo-tree-redo")
  undoTreeMap.bind("C-x u", "undo-tree-visualize")
  ctx.minorMode({ name: "undo-tree-mode", lighter: " Undo-Tree", keymap: undoTreeMap })
  ctx.minorMode({
    name: "global-undo-tree-mode",
    global: true,
    lighter: " Undo-Tree",
    onEnable: ed => {
      for (const buffer of ed.buffers.values()) buffer.minorModes.add("undo-tree-mode")
    },
    onDisable: ed => {
      for (const buffer of ed.buffers.values()) buffer.minorModes.delete("undo-tree-mode")
    },
  })

  const visualizerMap = new Keymap("undo-tree-visualizer-mode-map")
  for (const key of ["p", "C-p", "up"]) visualizerMap.bind(key, "undo-tree-visualize-undo")
  for (const key of ["n", "C-n", "down"]) visualizerMap.bind(key, "undo-tree-visualize-redo")
  for (const key of ["b", "C-b", "left"]) visualizerMap.bind(key, "undo-tree-visualize-switch-branch-left")
  for (const key of ["f", "C-f", "right"]) visualizerMap.bind(key, "undo-tree-visualize-switch-branch-right")
  visualizerMap.bind("return", "undo-tree-visualizer-quit")
  visualizerMap.bind("RET", "undo-tree-visualizer-quit")
  visualizerMap.bind("q", "undo-tree-visualizer-quit")
  visualizerMap.bind("S-q", "undo-tree-visualizer-quit")
  visualizerMap.bind("C-q", "undo-tree-visualizer-abort")
  visualizerMap.bind("t", "undo-tree-visualizer-toggle-timestamps")
  visualizerMap.bind("d", "undo-tree-visualizer-toggle-diff")
  defineMode({
    name: "undo-tree-visualizer-mode",
    parent: "text",
    keymap: visualizerMap,
    fontLock: undoTreeFontLock,
    mouseClick(buffer, point) {
      buffer.point = point
      setParentToVisualizerPoint(editor, buffer, point)
      return true
    },
  })

  ctx.hook("after-save-hook", async ({ editor: ed, buffer }) => {
    if (!(getCustom<boolean>("undo-tree-auto-save-history") ?? true)) return
    try { await saveHistory(ed, buffer) } catch { /* history persistence must not break save */ }
  })

  ctx.hook("find-file-hook", async ({ editor: ed, buffer }) => {
    if (ed.globalMinorModes.has("global-undo-tree-mode")) buffer.minorModes.add("undo-tree-mode")
    if (!(getCustom<boolean>("undo-tree-auto-save-history") ?? true)) return
    try { await loadHistory(ed, buffer) } catch { /* stale or invalid history is ignored */ }
  })

  ctx.command("undo-tree-mode", ({ editor, buffer, prefixArgument }) => {
    if (prefixArgument != null && prefixArgument <= 0) editor.disableMinorMode("undo-tree-mode", { buffer })
    else if (prefixArgument != null) editor.enableMinorMode("undo-tree-mode", { buffer })
    else editor.toggleMinorMode("undo-tree-mode", { buffer })
  }, "Toggle Undo-Tree mode.")

  ctx.command("global-undo-tree-mode", ({ editor, prefixArgument }) => {
    if (prefixArgument != null && prefixArgument <= 0) editor.disableMinorMode("global-undo-tree-mode")
    else if (prefixArgument != null) editor.enableMinorMode("global-undo-tree-mode")
    else editor.toggleMinorMode("global-undo-tree-mode")
  }, "Toggle Undo-Tree mode in all buffers.")

  ctx.command("undo-tree-undo", ({ editor, buffer }) => {
    if (didMoveUndo(buffer, () => buffer.undo())) editor.message("Undo")
    else editor.message("No further undo/redo information")
  }, "Undo one change using the undo tree.")

  ctx.command("undo-tree-redo", ({ editor, buffer }) => {
    if (didMoveUndo(buffer, () => buffer.redo())) editor.message("Redo")
    else editor.message("No further undo/redo information")
  }, "Redo one change using the active undo-tree branch.")

  ctx.command("undo-tree-switch-branch", async ({ editor, buffer, args, prefixArgument }) => {
    const snapshot = buffer.undoTreeSnapshot()
    const node = snapshot.current
    const count = buffer.undoBranchCount()
    if (count <= 1) {
      editor.message("No other branch")
      return
    }
    let branch = typeof prefixArgument === "number" ? prefixArgument : Number(args[0])
    if (!Number.isFinite(branch)) {
      const answer = await editor.prompt(`Branch (0-${count - 1}): `, String(node.activeChild), "undo-tree-switch-branch")
      if (answer == null) return
      branch = Number(answer)
    }
    branch = Math.max(0, Math.min(count - 1, Math.trunc(branch)))
    buffer.undoSetBranch(node.id, branch)
    editor.message(`Using branch ${branch} of ${count}`)
  }, "Switch the active redo branch at the current undo-tree node.")

  ctx.command("undo-tree-save-history", async ({ editor, buffer }) => {
    try {
      if (await saveHistory(editor, buffer)) editor.message("Wrote undo-tree history")
      else editor.message("No undo-tree history file for this buffer")
    } catch {
      editor.message("Could not write undo-tree history")
    }
  }, "Save undo-tree history for the current buffer.")

  ctx.command("undo-tree-load-history", async ({ editor, buffer }) => {
    try {
      if (await loadHistory(editor, buffer)) editor.message("Loaded undo-tree history")
      else editor.message("No matching undo-tree history")
    } catch {
      editor.message("No matching undo-tree history")
    }
  }, "Load undo-tree history for the current buffer.")

  ctx.command("undo-tree-visualize", ({ editor, buffer }) => {
    const name = visualizerName(buffer)
    const visualizer = utilityBuffer(editor, name, "", "undo-tree-visualizer-mode")
    visualizer.locals.set(VISUALIZER_STATE, {
      parentBufferId: buffer.id,
      openedAtNodeId: buffer.undoTreeSnapshot().current.id,
      showTimestamps: getCustom<boolean>("undo-tree-visualizer-timestamps") ?? false,
      showDiff: false,
    } satisfies VisualizerState)
    visualizer.readOnly = true
    renderVisualizer(editor, visualizer)
    editor.displayBufferInOtherWindow(visualizer.id, { select: true })
  }, "Visualize the current buffer's undo tree.")

  ctx.command("undo-tree-visualize-undo", ({ editor, buffer }) => {
    const parent = parentFromVisualizer(editor, buffer)
    if (!parent) return
    if (!didMoveUndo(parent, () => parent.undo())) editor.message("No further undo/redo information")
    rerenderCurrentVisualizer(editor, buffer)
  }, "Undo in the visualizer parent buffer.")

  ctx.command("undo-tree-visualize-redo", ({ editor, buffer }) => {
    const parent = parentFromVisualizer(editor, buffer)
    if (!parent) return
    if (!didMoveUndo(parent, () => parent.redo())) editor.message("No further undo/redo information")
    rerenderCurrentVisualizer(editor, buffer)
  }, "Redo in the visualizer parent buffer.")

  ctx.command("undo-tree-visualize-switch-branch-left", ({ editor, buffer }) => {
    const parent = parentFromVisualizer(editor, buffer)
    if (!parent) return
    switchBranch(parent, -1)
    rerenderCurrentVisualizer(editor, buffer)
  }, "Select the previous redo branch in the visualizer.")

  ctx.command("undo-tree-visualize-switch-branch-right", ({ editor, buffer }) => {
    const parent = parentFromVisualizer(editor, buffer)
    if (!parent) return
    switchBranch(parent, 1)
    rerenderCurrentVisualizer(editor, buffer)
  }, "Select the next redo branch in the visualizer.")

  ctx.command("undo-tree-visualizer-quit", ({ editor, buffer }) => {
    quitVisualizer(editor, buffer)
  }, "Quit the undo-tree visualizer.")

  ctx.command("undo-tree-visualizer-abort", ({ editor, buffer }) => {
    const state = visualizerState(buffer)
    const parent = parentFromVisualizer(editor, buffer)
    if (state && parent) parent.undoToNode(state.openedAtNodeId)
    quitVisualizer(editor, buffer)
  }, "Abort the undo-tree visualizer and restore the opening undo node.")

  ctx.command("undo-tree-visualizer-toggle-timestamps", ({ editor, buffer }) => {
    const state = visualizerState(buffer)
    if (!state) return
    state.showTimestamps = !state.showTimestamps
    rerenderCurrentVisualizer(editor, buffer)
  }, "Toggle timestamps in the undo-tree visualizer.")

  ctx.command("undo-tree-visualizer-toggle-diff", ({ editor, buffer }) => {
    const state = visualizerState(buffer)
    const parent = parentFromVisualizer(editor, buffer)
    if (!state || !parent) return
    state.showDiff = !state.showDiff
    if (state.showDiff) renderDiff(editor, parent)
    else editor.killBuffer("*undo-tree Diff*")
    rerenderCurrentVisualizer(editor, buffer)
  }, "Toggle the undo-tree visualizer diff buffer.")

  ctx.key("undo-tree-mode", "C-/", "undo-tree-undo")
  ctx.key("undo-tree-mode", "C-_", "undo-tree-undo")
  ctx.key("undo-tree-mode", "M-_", "undo-tree-redo")
  ctx.key("undo-tree-mode", "C-?", "undo-tree-redo")
  ctx.key("undo-tree-mode", "C-x u", "undo-tree-visualize")
}
