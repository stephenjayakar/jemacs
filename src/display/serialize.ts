import type { DisplayModel, WindowDisplayNode } from "./protocol"
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
  minibufferCompletions: SerializedThemedText
  minibufferCompletionLines: number
  minibuffer: SerializedThemedText
  echo: SerializedThemedText
  theme: DisplayModel["theme"]
  viewport: DisplayModel["viewport"]
  hostLabel: string
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
  clickState: { startLine: number; gutterPrefixLen: number }
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
    minibufferCompletions: serializeThemedText(model.minibufferCompletions),
    minibufferCompletionLines: model.minibufferCompletionLines,
    minibuffer: serializeThemedText(model.minibuffer),
    echo: serializeThemedText(model.echo),
    theme: model.theme,
    viewport: model.viewport,
    hostLabel: model.hostLabel,
  }
}

function serializeWindowNode(node: WindowDisplayNode): SerializedWindowNode {
  if (node.kind === "leaf") {
    return {
      kind: "leaf",
      pane: {
        id: node.pane.id,
        bufferId: node.pane.bufferId,
        selected: node.pane.selected,
        dedicated: node.pane.dedicated,
        body: serializeThemedText(node.pane.body),
        terminalSurface: node.pane.terminalSurface ? serializeTerminalSurface(node.pane.terminalSurface) : undefined,
        modeline: serializeThemedText(node.pane.modeline),
        clickState: node.pane.clickState,
        bodyLineBudget: node.pane.bodyLineBudget,
        syncText: node.pane.syncText,
        syncPoint: node.pane.syncPoint,
        textScale: node.pane.textScale,
      },
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

function serializeTerminalSurface(surface: TerminalSurfaceModel): TerminalSurfaceModel {
  return {
    ...surface,
    cells: surface.cells.map(row => row.map(cell => ({ ...cell }))),
  }
}
