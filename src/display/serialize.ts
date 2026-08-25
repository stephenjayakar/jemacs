import type { ChildFrameModel, DisplayModel, TableSurfaceModel, WebSurfaceModel, WindowDisplayNode } from "./protocol"
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
  tabBar?: SerializedThemedText
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
   *  characters into that row (pre-wrap). `shape` is the `cursor-type` custom. */
  cursor?: { row: number; colOffset: number; shape?: "bar" | "box" }
  terminalSurface?: TerminalSurfaceModel
  tableSurface?: TableSurfaceModel
  webSurface?: WebSurfaceModel
  footer?: SerializedThemedText
  modeline: SerializedThemedText
  clickState: {
    startLine: number
    gutterPrefixLen: number
    displayText?: string
    leftPadding?: number
    wrappedRows?: Array<{ line: number; start: number; end: number }>
  }
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
    tabBar: model.tabBar ? serializeThemedText(model.tabBar) : undefined,
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
    cursor: pane.cursor ? { ...pane.cursor } : undefined,
    terminalSurface: pane.terminalSurface ? serializeTerminalSurface(pane.terminalSurface) : undefined,
    tableSurface: pane.tableSurface ? serializeTableSurface(pane.tableSurface) : undefined,
    webSurface: pane.webSurface ? serializeWebSurface(pane.webSurface) : undefined,
    footer: pane.footer ? serializeThemedText(pane.footer) : undefined,
    modeline: serializeThemedText(pane.modeline),
    clickState: {
      startLine: pane.clickState.startLine,
      gutterPrefixLen: pane.clickState.gutterPrefixLen,
      leftPadding: pane.clickState.leftPadding,
      wrappedRows: pane.clickState.wrappedRows,
    },
    bodyLineBudget: pane.bodyLineBudget,
    syncText: pane.syncText,
    syncPoint: pane.syncPoint,
    textScale: pane.textScale,
  }
}

function serializeTableSurface(surface: TableSurfaceModel): TableSurfaceModel {
  return {
    kind: "table",
    columns: surface.columns.map(column => ({ ...column })),
    rows: surface.rows.map(row => ({
      ...row,
      cells: Object.fromEntries(Object.entries(row.cells).map(([key, cell]) => [key, { ...cell }])),
      actions: row.actions?.map(action => ({ ...action })),
    })),
    emptyText: surface.emptyText,
  }
}

/** Deep-copy so the diffing host never observes a model a mode mutated in place. */
function serializeWebSurface(surface: WebSurfaceModel): WebSurfaceModel {
  return {
    kind: "web",
    nodes: surface.nodes.map(cloneWebNode),
    ...(surface.canvas
      ? { canvas: { aspect: surface.canvas.aspect, shapes: surface.canvas.shapes.map(shape => ({ ...shape })) } }
      : {}),
  }
}

function cloneWebNode(node: WebSurfaceModel["nodes"][number]): WebSurfaceModel["nodes"][number] {
  return { ...node, ...(node.children ? { children: node.children.map(cloneWebNode) } : {}) }
}

function serializeTerminalSurface(surface: TerminalSurfaceModel): TerminalSurfaceModel {
  return {
    ...surface,
    cells: surface.cells.map(row => row.map(cell => ({ ...cell }))),
  }
}
