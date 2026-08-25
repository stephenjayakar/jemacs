import type { Editor } from "../../src/kernel/editor"
import { BufferModel } from "../../src/kernel/buffer"
import { Keymap } from "../../src/kernel/keymap"
import { defineMode } from "../../src/modes/mode"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import {
  install as installTabulatedList,
  renderTabulatedList,
  tabulatedListEntryAtPoint,
  tabulatedListState,
  TABULATED_LIST_REVERT_LOCAL,
  type TabulatedListColumn,
  type TabulatedListEntry,
} from "../tabulated-list"

export const IBUFFER_STATE_LOCAL = "ibuffer-state"

type IbufferMark = "*" | "D"
type IbufferState = {
  marks: Map<string, IbufferMark>
  filters: unknown[]
}

const IBUFFER_NAME = "*Ibuffer*"
const columns: TabulatedListColumn[] = [
  { name: "MR", width: 2 },
  { name: "Name", width: 24, sortable: true },
  { name: "Size", width: 7, sortable: true, align: "right" },
  { name: "Mode", width: 18, sortable: true },
  { name: "File", width: 48, sortable: true },
]

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  installTabulatedList(editor, ctx)

  const keymap = new Keymap("ibuffer-mode-map")
  for (const key of ["n", "C-n", "down"]) keymap.bind(key, "next-line")
  for (const key of ["p", "C-p", "up"]) keymap.bind(key, "previous-line")
  keymap.bind("m", "ibuffer-mark-forward")
  keymap.bind("u", "ibuffer-unmark-forward")
  keymap.bind("d", "ibuffer-mark-for-delete")
  keymap.bind("x", "ibuffer-do-kill-on-deletion-marks")
  keymap.bind("g", "tabulated-list-revert")
  keymap.bind("enter", "ibuffer-visit-buffer")
  keymap.bind("return", "ibuffer-visit-buffer")
  keymap.bind("C-m", "ibuffer-visit-buffer")
  keymap.bind("o", "ibuffer-visit-buffer-other-window")
  keymap.bind("/", "ibuffer-filter")

  defineMode({
    name: "ibuffer-mode",
    parent: "tabulated-list-mode",
    keymap,
    onEnter: buffer => { buffer.readOnly = true },
  })

  ctx.command("ibuffer", ({ editor }) => {
    showIbuffer(editor)
  }, "Display the buffer list in Ibuffer.")

  ctx.command("ibuffer-mark-forward", ({ editor, buffer }) => {
    markCurrentBuffer(editor, buffer, "*")
  }, "Mark the buffer at point.")

  ctx.command("ibuffer-unmark-forward", ({ editor, buffer }) => {
    unmarkCurrentBuffer(editor, buffer)
  }, "Remove the Ibuffer mark at point.")

  ctx.command("ibuffer-mark-for-delete", ({ editor, buffer }) => {
    markCurrentBuffer(editor, buffer, "D")
  }, "Flag the buffer at point for deletion.")

  ctx.command("ibuffer-do-kill-on-deletion-marks", ({ editor, buffer }) => {
    executeDeletions(editor, buffer)
  }, "Kill buffers flagged for deletion.")

  ctx.command("ibuffer-do-kill-lines", ({ editor, buffer }) => {
    executeDeletions(editor, buffer)
  }, "Compatibility alias for killing buffers flagged in Ibuffer.")

  ctx.command("ibuffer-visit-buffer", ({ editor, buffer }) => {
    const target = bufferAtPoint(editor, buffer)
    if (!target) return
    editor.switchToBuffer(target.id)
    editor.message(`Switched to ${editor.bufferDisplayName(target)}`)
  }, "Visit the buffer at point.")

  ctx.command("ibuffer-visit-buffer-other-window", ({ editor, buffer }) => {
    const target = bufferAtPoint(editor, buffer)
    if (!target) return
    const shown = editor.displayBufferInOtherWindow(target.id)
    editor.message(`Switched to ${editor.bufferDisplayName(shown)} in other window`)
  }, "Visit the buffer at point in another window.")

  ctx.command("ibuffer-filter", ({ editor, buffer }) => {
    ibufferState(buffer).filters = []
    editor.message("Ibuffer filters are not implemented")
  }, "Placeholder for Ibuffer filters.")
}

export function showIbuffer(editor: Editor): BufferModel {
  const existing = [...editor.buffers.values()].find(buffer => buffer.name === IBUFFER_NAME)
  const buffer = existing ?? new BufferModel({ name: IBUFFER_NAME, kind: "scratch", mode: "ibuffer-mode" })
  if (!existing) editor.addBuffer(buffer)
  editor.enterMode(buffer, "ibuffer-mode")
  buffer.locals.set(TABULATED_LIST_REVERT_LOCAL, () => renderIbuffer(editor, buffer))
  renderIbuffer(editor, buffer)
  if (buffer.lineAt(buffer.point) === 0 && tabulatedListState(buffer)?.entries.length) {
    buffer.point = buffer.lineStarts[1] ?? buffer.point
  }
  editor.switchToBuffer(buffer.id)
  void editor.changed("ibuffer")
  return buffer
}

export function renderIbuffer(editor: Editor, buffer: BufferModel): void {
  const state = ibufferState(buffer)
  pruneMarks(editor, state)
  const previousTable = tabulatedListState(buffer)
  const entries: TabulatedListEntry[] = [...editor.buffers.values()]
    .filter(candidate => candidate.kind !== "minibuffer")
    .map(candidate => ({
      id: candidate.id,
      marked: state.marks.has(candidate.id),
      cells: [
        markCell(candidate, state),
        editor.bufferDisplayName(candidate),
        candidate.text.length,
        candidate.mode,
        candidate.path ?? "",
      ],
    }))
  renderTabulatedList(buffer, {
    columns,
    entries,
    sortColumn: previousTable?.sortColumn,
    sortReverse: previousTable?.sortReverse,
  })
}

function ibufferState(buffer: BufferModel): IbufferState {
  let state = buffer.locals.get(IBUFFER_STATE_LOCAL) as IbufferState | undefined
  if (!state) {
    state = { marks: new Map(), filters: [] }
    buffer.locals.set(IBUFFER_STATE_LOCAL, state)
  }
  return state
}

function markCell(buffer: BufferModel, state: IbufferState): string {
  const mark = state.marks.get(buffer.id) ?? " "
  const flag = buffer.readOnly ? "%" : buffer.dirty ? "*" : " "
  return `${mark}${flag}`
}

function bufferAtPoint(editor: Editor, buffer: BufferModel): BufferModel | null {
  const entry = tabulatedListEntryAtPoint(buffer)
  return entry ? editor.buffers.get(entry.id) ?? null : null
}

function executeDeletions(editor: Editor, buffer: BufferModel): void {
  const state = ibufferState(buffer)
  let killed = 0
  for (const [id, mark] of [...state.marks]) {
    if (mark !== "D") continue
    if (id === buffer.id) {
      state.marks.delete(id)
      continue
    }
    if (editor.killBuffer(id)) killed++
    state.marks.delete(id)
  }
  pruneMarks(editor, state)
  renderIbuffer(editor, buffer)
  editor.message(`Ibuffer: killed ${killed} buffer${killed === 1 ? "" : "s"}`)
}

function markCurrentBuffer(editor: Editor, buffer: BufferModel, mark: IbufferMark): void {
  const target = bufferAtPoint(editor, buffer)
  if (!target) return
  const line = buffer.lineAt(buffer.point)
  ibufferState(buffer).marks.set(target.id, mark)
  renderIbuffer(editor, buffer)
  moveToListLine(buffer, line + 1)
  void editor.changed("ibuffer-mark")
}

function unmarkCurrentBuffer(editor: Editor, buffer: BufferModel): void {
  const target = bufferAtPoint(editor, buffer)
  if (!target) return
  const line = buffer.lineAt(buffer.point)
  ibufferState(buffer).marks.delete(target.id)
  renderIbuffer(editor, buffer)
  moveToListLine(buffer, line + 1)
  void editor.changed("ibuffer-unmark")
}

function moveToListLine(buffer: BufferModel, line: number): void {
  const state = tabulatedListState(buffer)
  const maxLine = state?.entries.length ?? 0
  const next = Math.max(1, Math.min(line, maxLine))
  buffer.point = buffer.lineStarts[next] ?? buffer.point
}

function pruneMarks(editor: Editor, state: IbufferState): void {
  for (const id of [...state.marks.keys()]) {
    const buffer = editor.buffers.get(id)
    if (!buffer || buffer.kind === "minibuffer") state.marks.delete(id)
  }
}
