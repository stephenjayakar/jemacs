import type { Editor } from "../kernel/editor"
import { BufferModel } from "../kernel/buffer"
import { Keymap } from "../kernel/keymap"
import { defineMode } from "./mode"

const BUFFER_LIST_NAME = "*Buffer List*"
const NAME_WIDTH = 24

type BufferMenuMark = "D" | "S" | ">"
type BufferListSort = "none" | "name" | "size" | "mode"
type BufferListState = {
  filesOnly: boolean
  sort: BufferListSort
  marks: Map<string, BufferMenuMark>
}

const bufferListIds = new WeakMap<BufferModel, string[]>()
const bufferListStates = new WeakMap<BufferModel, BufferListState>()

export function installBufferListMode(): void {
  const keymap = new Keymap("buffer-list-map")
  keymap.bind("d", "Buffer-menu-delete")
  keymap.bind("C-d", "Buffer-menu-delete-backwards")
  keymap.bind("x", "Buffer-menu-execute")
  keymap.bind("u", "Buffer-menu-unmark")
  keymap.bind("backspace", "Buffer-menu-backup-unmark")
  keymap.bind("delete", "Buffer-menu-backup-unmark")
  keymap.bind("s", "Buffer-menu-save")
  keymap.bind("~", "Buffer-menu-not-modified")
  keymap.bind("m", "Buffer-menu-mark")
  keymap.bind("v", "Buffer-menu-select")
  keymap.bind("%", "Buffer-menu-toggle-read-only")
  keymap.bind("o", "Buffer-menu-other-window")
  keymap.bind("1", "Buffer-menu-1-window")
  keymap.bind("2", "Buffer-menu-2-window")
  keymap.bind("S-s", "Buffer-menu-sort")
  keymap.bind("S-t", "Buffer-menu-toggle-files-only")
  keymap.bind("enter", "Buffer-menu-select")
  keymap.bind("return", "Buffer-menu-select")
  keymap.bind("C-m", "Buffer-menu-select")
  defineMode({ name: "buffer-list", parent: "text", keymap })
}

export function installBufferListCommands(editor: Editor): void {
  editor.command("Buffer-menu-delete", ({ buffer, editor }) => {
    markCurrentLine(buffer, "D")
    moveLine(buffer, 1)
    refreshBufferList(editor, buffer)
  }, "Mark this buffer for deletion and move down.")

  editor.command("Buffer-menu-delete-backwards", ({ buffer, editor }) => {
    markCurrentLine(buffer, "D")
    moveLine(buffer, -1)
    refreshBufferList(editor, buffer)
  }, "Mark this buffer for deletion and move up.")

  editor.command("Buffer-menu-execute", async ({ buffer, editor }) => {
    const state = stateFor(buffer)
    let saved = 0
    let killed = 0
    for (const [id, mark] of [...state.marks]) {
      const target = editor.buffers.get(id)
      if (!target) {
        state.marks.delete(id)
        continue
      }
      if (mark === "S") {
        try {
          await target.save()
          saved++
        } catch (err) {
          editor.message((err as Error).message)
        }
      }
    }
    for (const [id, mark] of [...state.marks]) {
      if (mark !== "D") continue
      if (id === buffer.id) continue
      if (editor.killBuffer(id)) killed++
    }
    state.marks.clear()
    refreshBufferList(editor, buffer)
    editor.message(`Buffer Menu: saved ${saved}, killed ${killed}`)
  }, "Save and delete buffers flagged in Buffer Menu.")

  editor.command("Buffer-menu-unmark", ({ buffer, editor }) => {
    unmarkCurrentLine(buffer)
    moveLine(buffer, 1)
    refreshBufferList(editor, buffer)
  }, "Remove this line's Buffer Menu mark and move down.")

  editor.command("Buffer-menu-backup-unmark", ({ buffer, editor }) => {
    moveLine(buffer, -1)
    unmarkCurrentLine(buffer)
    refreshBufferList(editor, buffer)
  }, "Move up and remove that line's Buffer Menu mark.")

  editor.command("Buffer-menu-save", ({ buffer, editor }) => {
    markCurrentLine(buffer, "S")
    moveLine(buffer, 1)
    refreshBufferList(editor, buffer)
  }, "Mark this buffer to be saved by Buffer-menu-execute.")

  editor.command("Buffer-menu-not-modified", ({ buffer, editor }) => {
    const target = currentEntry(editor, buffer)
    if (!target) return
    target.dirty = false
    moveLine(buffer, 1)
    refreshBufferList(editor, buffer)
  }, "Clear this line buffer's modified flag.")

  editor.command("Buffer-menu-mark", ({ buffer, editor }) => {
    markCurrentLine(buffer, ">")
    moveLine(buffer, 1)
    refreshBufferList(editor, buffer)
  }, "Mark this buffer for Buffer-menu-select.")

  editor.command("Buffer-menu-select", ({ buffer, editor }) => {
    const ids = selectedEntryIds(buffer)
    if (!ids.length) {
      const target = currentEntry(editor, buffer)
      if (!target) return
      editor.switchToBuffer(target.id)
      editor.message(`Switched to ${editor.bufferDisplayName(target)}`)
      return
    }
    selectBuffers(editor, ids)
  }, "Select marked buffers, or this line's buffer.")

  editor.command("Buffer-menu-toggle-read-only", ({ buffer, editor }) => {
    const target = currentEntry(editor, buffer)
    if (!target) return
    target.readOnly = !target.readOnly
    refreshBufferList(editor, buffer)
    editor.message(`${editor.bufferDisplayName(target)} is ${target.readOnly ? "read-only" : "writable"}`)
  }, "Toggle this line buffer's read-only flag.")

  editor.command("Buffer-menu-other-window", ({ buffer, editor }) => {
    const target = currentEntry(editor, buffer)
    if (!target) return
    const shown = editor.displayBufferInOtherWindow(target.id)
    editor.message(`Switched to ${editor.bufferDisplayName(shown)} in other window`)
  }, "Select this line's buffer in another window.")

  editor.command("Buffer-menu-1-window", ({ buffer, editor }) => {
    const target = currentEntry(editor, buffer)
    if (!target) return
    editor.switchToBuffer(target.id)
    void editor.run("delete-other-windows")
    editor.message(`Switched to ${editor.bufferDisplayName(target)}`)
  }, "Select this line's buffer, alone in one window.")

  editor.command("Buffer-menu-2-window", ({ buffer, editor }) => {
    const target = currentEntry(editor, buffer)
    if (!target) return
    editor.displayBufferInOtherWindow(target.id, { select: false })
    editor.message(`Displayed ${editor.bufferDisplayName(target)} in other window`)
  }, "Display this line's buffer in another window.")

  editor.command("Buffer-menu-toggle-files-only", ({ buffer, editor }) => {
    const state = stateFor(buffer)
    state.filesOnly = !state.filesOnly
    refreshBufferList(editor, buffer)
    editor.message(state.filesOnly ? "Buffer Menu: file buffers only" : "Buffer Menu: all buffers")
  }, "Toggle whether Buffer Menu shows only file-visiting buffers.")

  editor.command("Buffer-menu-sort", ({ buffer, editor }) => {
    const state = stateFor(buffer)
    state.sort = state.sort === "none" ? "name" : state.sort === "name" ? "size" : state.sort === "size" ? "mode" : "none"
    refreshBufferList(editor, buffer)
    editor.message(`Buffer Menu: sort by ${state.sort}`)
  }, "Cycle Buffer Menu sorting by name, size, and mode.")
}

export function showBufferList(editor: Editor, options: { filesOnly?: boolean } = {}): BufferModel {
  const existing = [...editor.buffers.values()].find(b => b.name === BUFFER_LIST_NAME)
  const buffer = existing ?? new BufferModel({ name: BUFFER_LIST_NAME, kind: "scratch", mode: "buffer-list" })
  if (!existing) editor.addBuffer(buffer)
  const state = stateFor(buffer)
  state.filesOnly = options.filesOnly ?? false
  renderBufferList(editor, buffer, { filesOnly: state.filesOnly })
  buffer.readOnly = true
  editor.enterMode(buffer, "buffer-list")
  editor.switchToBuffer(buffer.id)
  void editor.changed("buffer-list")
  return buffer
}

export function renderBufferList(editor: Editor, buffer: BufferModel, options: { filesOnly?: boolean } = {}): void {
  const ids: string[] = []
  const state = stateFor(buffer)
  state.filesOnly = options.filesOnly ?? state.filesOnly
  for (const id of [...state.marks.keys()]) {
    if (!editor.buffers.has(id)) state.marks.delete(id)
  }
  const entries = [...editor.buffers.values()]
    .filter(b => b.kind !== "minibuffer")
    .filter(b => !state.filesOnly || b.path)
    .sort((a, b) => compareBufferListEntry(editor, a, b, state.sort))
  const lines = entries
    .map(b => {
      ids.push(b.id)
      const current = b.id === editor.currentBufferId ? "." : " "
      const mark = state.marks.get(b.id) ?? " "
      const readOnly = b.readOnly ? "%" : " "
      const dirty = b.dirty ? "*" : " "
      const path = b.path ? `  ${b.path}` : ""
      return `${current}${mark}${readOnly}${dirty} ${editor.bufferDisplayName(b).padEnd(NAME_WIDTH)} ${b.mode}${path}`
    })
  bufferListIds.set(buffer, ids)
  buffer.setText(lines.join("\n"), false)
}

export function bufferListEntryAtPoint(buffer: BufferModel): string | undefined {
  const lineNo = buffer.text.slice(0, buffer.point).split("\n").length - 1
  return bufferListIds.get(buffer)?.[lineNo]
}

function stateFor(buffer: BufferModel): BufferListState {
  let state = bufferListStates.get(buffer)
  if (!state) {
    state = { filesOnly: false, sort: "none", marks: new Map() }
    bufferListStates.set(buffer, state)
  }
  return state
}

function compareBufferListEntry(editor: Editor, a: BufferModel, b: BufferModel, sort: BufferListSort): number {
  if (sort === "none") return 0 // stable sort keeps the original visit order
  const byName = editor.bufferDisplayName(a).localeCompare(editor.bufferDisplayName(b))
  if (sort === "name") return byName
  if (sort === "size") return a.text.length - b.text.length || byName
  return a.mode.localeCompare(b.mode) || byName
}

function currentLine(buffer: BufferModel): number {
  return buffer.text.slice(0, buffer.point).split("\n").length - 1
}

function moveLine(buffer: BufferModel, delta: number): void {
  buffer.moveLine(delta)
  buffer.moveToLineStart()
}

function restoreLine(buffer: BufferModel, line: number): void {
  const starts = buffer.lineStarts
  buffer.point = starts[Math.max(0, Math.min(line, starts.length - 1))] ?? 0
}

function refreshBufferList(editor: Editor, buffer: BufferModel): void {
  const line = currentLine(buffer)
  renderBufferList(editor, buffer, { filesOnly: stateFor(buffer).filesOnly })
  restoreLine(buffer, line)
  void editor.changed("buffer-list-refresh")
}

function markCurrentLine(buffer: BufferModel, mark: BufferMenuMark): void {
  const id = bufferListEntryAtPoint(buffer)
  if (!id) return
  stateFor(buffer).marks.set(id, mark)
}

function unmarkCurrentLine(buffer: BufferModel): void {
  const id = bufferListEntryAtPoint(buffer)
  if (!id) return
  stateFor(buffer).marks.delete(id)
}

function currentEntry(editor: Editor, buffer: BufferModel): BufferModel | undefined {
  const id = bufferListEntryAtPoint(buffer)
  return id ? editor.buffers.get(id) : undefined
}

function selectedEntryIds(buffer: BufferModel): string[] {
  return [...stateFor(buffer).marks].filter(([, mark]) => mark === ">").map(([id]) => id)
}

function selectBuffers(editor: Editor, ids: string[]): void {
  const buffers = ids.map(id => editor.buffers.get(id)).filter((b): b is BufferModel => !!b)
  if (!buffers.length) return
  editor.switchToBuffer(buffers[0]!.id)
  for (const target of buffers.slice(1)) {
    editor.displayBufferInOtherWindow(target.id)
  }
  editor.message(`Selected ${buffers.map(b => editor.bufferDisplayName(b)).join(", ")}`)
}
