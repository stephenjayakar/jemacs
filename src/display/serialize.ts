import type { ChildFrameModel, DisplayModel, WindowDisplayNode } from "./protocol"
import type { TerminalSurfaceModel } from "./terminal-surface"
import type { ThemedText } from "./themed-text"

export type SerializedThemedText = {
  chunks: Array<{
    text: string
    fg?: string
    bg?: string
    bold?: boolean
    italic?: boolean
    underline?: boolean
    family?: string
    height?: number
    heightScale?: number
  }>
}
export type SerializedDisplayModel = {
  title: SerializedThemedText
  windows: SerializedWindowNode
  childFrames: SerializedChildFrame[]
  minibufferCompletions: SerializedThemedText
  minibufferCompletionLines: number
  minibuffer: SerializedThemedText
  echo: SerializedThemedText
  theme: DisplayModel["theme"]
  viewport: DisplayModel["viewport"]
  hostLabel: string
}

export type SerializedChildFrame = {
  id: string
  parentFrameId: string
  pane: SerializedPane
  top: number
  left: number
  width: number
  height: number
}

export type SerializedWindowNode =
  | { kind: "leaf"; pane: SerializedPane }
  | { kind: "split"; direction: "horizontal" | "vertical"; firstRatio?: number; first: SerializedWindowNode; second: SerializedWindowNode }

export type SerializedPane = {
  id: string
  bufferId: string
  selected: boolean
  dedicated: boolean
  body: SerializedThemedText
  /** When set, the host renders a positioned caret instead of an in-body █
   *  glyph. `row` is the logical-line index into `body`; `colOffset` counts
   *  characters into that row (pre-wrap). */
  cursor?: { row: number; colOffset: number }
  terminalSurface?: TerminalSurfaceModel
  modeline: SerializedThemedText
  clickState: { startLine: number; gutterPrefixLen: number; displayText?: string; leftPadding?: number }
  bodyLineBudget: number
  syncText: string
  syncPoint: number
  textScale: number
}

export function serializeThemedText(text: ThemedText): SerializedThemedText {
  return { chunks: text.chunks.map(c => ({ ...c })) }
}

export function serializeDisplayModel(model: DisplayModel): SerializedDisplayModel {
  return {
    title: serializeThemedText(model.title),
    windows: serializeWindowNode(model.windows),
    childFrames: model.childFrames.map(serializeChildFrame),
    minibufferCompletions: serializeThemedText(model.minibufferCompletions),
    minibufferCompletionLines: model.minibufferCompletionLines,
    minibuffer: serializeThemedText(model.minibuffer),
    echo: serializeThemedText(model.echo),
    theme: model.theme,
    viewport: model.viewport,
    hostLabel: model.hostLabel,
  }
}

function serializeChildFrame(frame: ChildFrameModel): SerializedChildFrame {
  return {
    id: frame.id,
    parentFrameId: frame.parentFrameId,
    pane: serializePane(frame.pane),
    top: frame.top,
    left: frame.left,
    width: frame.width,
    height: frame.height,
  }
}

function serializeWindowNode(node: WindowDisplayNode): SerializedWindowNode {
  if (node.kind === "leaf") {
    return {
      kind: "leaf",
      pane: serializePane(node.pane),
    }
  }
  return {
    kind: "split",
    direction: node.direction,
    firstRatio: node.firstRatio,
    first: serializeWindowNode(node.first),
    second: serializeWindowNode(node.second),
  }
}

function serializePane(pane: DisplayModel["childFrames"][number]["pane"]): SerializedPane {
  return {
    id: pane.id,
    bufferId: pane.bufferId,
    selected: pane.selected,
    dedicated: pane.dedicated,
    body: serializeThemedText(pane.body),
    terminalSurface: pane.terminalSurface ? serializeTerminalSurface(pane.terminalSurface) : undefined,
    modeline: serializeThemedText(pane.modeline),
    clickState: {
      startLine: pane.clickState.startLine,
      gutterPrefixLen: pane.clickState.gutterPrefixLen,
      leftPadding: pane.clickState.leftPadding,
    },
    bodyLineBudget: pane.bodyLineBudget,
    syncText: pane.syncText,
    syncPoint: pane.syncPoint,
    textScale: pane.textScale,
  }
}

function serializeTerminalSurface(surface: TerminalSurfaceModel): TerminalSurfaceModel {
  return {
    ...surface,
    cells: surface.cells.map(row => row.map(cell => ({ ...cell }))),
  }
}
