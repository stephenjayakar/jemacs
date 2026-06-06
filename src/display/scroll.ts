import { textScaleFactor } from "../core/text-scale"
import type { Editor } from "../kernel/editor"
import type { BufferModel } from "../kernel/buffer"
import { findWindowLeaf, type WindowNode } from "../kernel/window"
import { defcustom, getCustom } from "../runtime/custom"
import type { HostCapabilities } from "./protocol"
import { syncViewportStartLine } from "./visual-line-height"
import {
  contentAreaLines,
  defaultTerminalRows,
  pageScrollLines,
  windowBodyLines,
  type ViewportSize,
} from "./viewport"
import { computeLineVisualRows, visibleLineCountForBudget } from "./visual-line-height"

defcustom("next-screen-context-lines", "number", 2,
  "Lines of overlap left when scrolling by a screenful (C-v / M-v).")

defcustom("scroll-error-top-bottom", "boolean", false,
  "Move point to top/bottom of buffer before signaling a scrolling error.")

export class ScrollBoundary extends Error {
  readonly which: "beginning" | "end"
  constructor(which: "beginning" | "end") {
    super(which)
    this.which = which
  }
}

/** `scroll-up-command` (C-v): scroll forward / text moves up. */
export function scrollUpCommand(editor: Editor, arg: number | null): void {
  if (arg != null && arg < 0) {
    scrollDownCommand(editor, -arg)
    return
  }
  runScrollCommand(editor, arg, 1)
}

/** `scroll-down-command` (M-v): scroll backward / text moves down. */
export function scrollDownCommand(editor: Editor, arg: number | null): void {
  if (arg != null && arg < 0) {
    scrollUpCommand(editor, -arg)
    return
  }
  runScrollCommand(editor, arg, -1)
}

function runScrollCommand(editor: Editor, arg: number | null, direction: 1 | -1): void {
  const scrollErrorTopBottom = getCustom<boolean>("scroll-error-top-bottom") ?? false
  try {
    windowScroll(editor, arg, direction)
  } catch (error) {
    if (!(error instanceof ScrollBoundary)) throw error
    if (!scrollErrorTopBottom) {
      editor.message(error.which === "beginning" ? "Beginning of buffer" : "End of buffer")
      return
    }
    const buffer = editor.currentBuffer
    if (error.which === "beginning") {
      if (arg != null) buffer.moveLine(-arg)
      else buffer.moveToBufferStart()
    } else {
      if (arg != null) buffer.moveLine(arg)
      else buffer.moveToBufferEnd()
    }
  }
}

/** Core of Emacs `window_scroll` / `window_scroll_line_based` (line-based path). */
function windowScroll(editor: Editor, prefixArg: number | null, direction: 1 | -1): void {
  const leaf = editor.selectedWindowLeaf()
  if (!leaf) return
  const buffer = editor.currentBuffer
  const lineCount = buffer.text.split("\n").length
  if (lineCount === 0) return

  const bodyBudget = selectedWindowBodyBudget(editor)
  const visualRows = visualRowsForBuffer(editor, buffer)
  const context = Math.max(0, getCustom<number>("next-screen-context-lines") ?? 2)
  const whole = prefixArg == null
  const n = whole
    ? direction * Math.max(1, bodyBudget - context)
    : prefixArg! * direction

  const oldPointLine = buffer.lineCol().line - 1
  let startLine = leaf.startLine

  // If point is not visible, move window start toward point (half-window recenter).
  const visibleBefore = visibleLinesAtStart(startLine, bodyBudget, lineCount, visualRows)
  if (oldPointLine < startLine || oldPointLine >= startLine + visibleBefore) {
    startLine = syncViewportStartLine(startLine, oldPointLine, bodyBudget, visualRows)
  }

  if (n < 0 && startLine === 0) throw new ScrollBoundary("beginning")

  const maxStart = maxStartLine(bodyBudget, lineCount, visualRows)
  const newStart = Math.max(0, Math.min(maxStart, startLine + n))
  const scrolled = newStart - startLine

  if (n > 0 && scrolled === 0 && startLine >= maxStart) throw new ScrollBoundary("end")
  if (n < 0 && scrolled === 0 && startLine === 0) throw new ScrollBoundary("beginning")

  editor.setSelectedWindowStartLine(newStart)

  let newPointLine = oldPointLine
  if (n > 0) {
    const topMargin = newStart
    if (topMargin > oldPointLine) newPointLine = topMargin
  } else if (n < 0) {
    const visibleAfter = visibleLinesAtStart(newStart, bodyBudget, lineCount, visualRows)
    const bottomMargin = newStart + visibleAfter - 1
    if (bottomMargin <= oldPointLine) newPointLine = bottomMargin
  }

  setBufferPointToLine(buffer, newPointLine, buffer.lineCol().col)
}

export function selectedWindowBodyBudget(editor: Editor): number {
  const viewport = editor.lastViewport ?? { rows: defaultTerminalRows() }
  const areaLines = contentAreaLinesForEditor(editor, viewport)
  return leafBodyBudget(editor.windowLayout, editor.selectedWindowId, areaLines)
    ?? pageScrollLines(viewport.rows)
}

function contentAreaLinesForEditor(editor: Editor, viewport: ViewportSize): number {
  const completionText = editor.minibufferCompletionDisplay?.text
  const completionLines = completionText ? Math.max(1, completionText.split("\n").length) : 0
  const overlayRows = editor.minibuffer ? editor.activeBuffer.text.split("\n").length - 1 : 0
  return Math.max(2, contentAreaLines(viewport.rows) - completionLines - overlayRows)
}

function leafBodyBudget(layout: WindowNode, leafId: string, availableLines: number): number | null {
  if (layout.kind === "leaf") {
    return layout.id === leafId ? windowBodyLines(availableLines) : null
  }
  const split = splitLineBudget(availableLines, layout.direction, layout.firstRatio)
  return leafBodyBudget(layout.first, leafId, split.first)
    ?? leafBodyBudget(layout.second, leafId, split.second)
}

function splitLineBudget(availableLines: number, direction: "horizontal" | "vertical", firstRatio = 0.5): { first: number; second: number } {
  if (direction === "horizontal") {
    return { first: availableLines, second: availableLines }
  }
  const first = proportionalBudget(availableLines, firstRatio, 3)
  return { first, second: Math.max(3, availableLines - first) }
}

function proportionalBudget(total: number, firstRatio: number, min: number): number {
  if (total <= min * 2) return Math.floor(total / 2)
  const ratio = Math.max(0.05, Math.min(0.95, firstRatio))
  return Math.max(min, Math.min(total - min, Math.floor(total * ratio)))
}

function visualRowsForBuffer(editor: Editor, buffer: BufferModel): number[] | undefined {
  if (!editor.lastHostCapabilities?.perFaceFonts) return undefined
  const spans = [...editor.fontLock(buffer)]
  return computeLineVisualRows(buffer.text, spans, editor.theme, buffer, textScaleFactor(buffer))
}

function visibleLinesAtStart(
  startLine: number,
  bodyBudget: number,
  lineCount: number,
  visualRows?: readonly number[],
): number {
  if (!visualRows?.length) return Math.min(bodyBudget, Math.max(1, lineCount - startLine))
  return visibleLineCountForBudget(startLine, bodyBudget, lineCount, visualRows)
}

// Emacs lets C-v advance until the last line is alone at the top; only signal
// end-of-buffer when already there, don't pre-clamp the step.
function maxStartLine(_bodyBudget: number, lineCount: number, _visualRows?: readonly number[]): number {
  return Math.max(0, lineCount - 1)
}

function setBufferPointToLine(buffer: BufferModel, lineIndex: number, col: number): void {
  const lines = buffer.text.split("\n")
  const targetLine = Math.max(0, Math.min(lines.length - 1, lineIndex))
  let offset = 0
  for (let i = 0; i < targetLine; i++) offset += lines[i]!.length + 1
  buffer.point = Math.max(0, Math.min(buffer.text.length, offset + Math.min(col - 1, lines[targetLine]!.length)))
}

/** @internal */
export function setEditorDisplayContext(
  editor: Editor,
  viewport: ViewportSize,
  hostCapabilities?: HostCapabilities,
): void {
  editor.lastViewport = viewport
  editor.lastHostCapabilities = hostCapabilities
}
