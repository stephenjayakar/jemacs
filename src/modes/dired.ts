import { basename, dirname, join, resolve } from "node:path"
import { cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import type { Editor } from "../kernel/editor"
import { BufferModel } from "../kernel/buffer"
import { Keymap } from "../kernel/keymap"
import { defineMode, type TextSpan } from "./mode"

export type DiredEntry = {
  name: string
  path: string
  isDirectory: boolean
  size: number
  mtime: Date
}

export type DiredMark = "marked" | "delete"

const diredEntryLines = new WeakMap<BufferModel, DiredEntry[]>()
const diredMarks = new WeakMap<BufferModel, Map<string, DiredMark>>()

const HEADER_LINES = 2
const NAME_OFFSET = 22

export function installDiredMode(): void {
  const keymap = new Keymap("dired-map")
  keymap.bind("enter", "dired-find-file")
  keymap.bind("g", "dired-revert")
  keymap.bind("^", "dired-up-directory")
  keymap.bind("q", "quit-window")
  keymap.bind("m", "dired-mark")
  keymap.bind("u", "dired-unmark")
  keymap.bind("U", "dired-unmark-all")
  keymap.bind("t", "dired-toggle-mark")
  keymap.bind("% .", "dired-mark-all")
  keymap.bind("% m", "dired-mark-files-regexp")
  keymap.bind("% d", "dired-flag-files-regexp")
  keymap.bind("d", "dired-flag-file-deletion")
  keymap.bind("x", "dired-do-flagged-delete")
  keymap.bind("D", "dired-do-delete")
  keymap.bind("C", "dired-do-copy")
  keymap.bind("R", "dired-do-rename")
  keymap.bind("+", "dired-create-directory")
  keymap.bind("backspace", "dired-unmark-backward")
  defineMode({ name: "dired", parent: "text", keymap, fontLock: diredFontLock })
}

export async function makeDiredBuffer(path: string): Promise<BufferModel> {
  const dir = resolve(path)
  const buffer = new BufferModel({ name: `${basename(dir) || dir}/`, path: dir, kind: "directory", mode: "dired" })
  buffer.readOnly = true
  diredMarks.set(buffer, new Map())
  await refreshDiredBuffer(buffer)
  return buffer
}

export async function refreshDiredBuffer(buffer: BufferModel): Promise<void> {
  if (!buffer.path) throw new Error(`Dired buffer ${buffer.name} has no directory path`)
  const previousMarks = diredMarks.get(buffer) ?? new Map()
  const names = await readdir(buffer.path)
  const entries: DiredEntry[] = [
    await entryFor(buffer.path, "."),
    await entryFor(buffer.path, ".."),
  ]
  for (const name of names.sort((a, b) => a.localeCompare(b))) entries.push(await entryFor(buffer.path, name))

  const marks = new Map<string, DiredMark>()
  for (const entry of entries) {
    const kept = previousMarks.get(entry.path)
    if (kept) marks.set(entry.path, kept)
  }
  diredMarks.set(buffer, marks)
  diredEntryLines.set(buffer, entries)
  renderDiredBuffer(buffer, entries)
}

export function diredEntryAtPoint(buffer: BufferModel): DiredEntry | undefined {
  const lineNo = buffer.text.slice(0, buffer.point).split("\n").length - 1
  if (lineNo < HEADER_LINES) return undefined
  return diredEntryLines.get(buffer)?.[lineNo - HEADER_LINES]
}

export function diredFontLock(buffer: BufferModel): TextSpan[] {
  const spans: TextSpan[] = []
  let offset = 0
  for (const line of buffer.text.split("\n")) {
    if (line.length > 0) {
      const mark = line[0]
      if (mark === "*") spans.push({ start: offset, end: offset + 1, face: "constant" })
      if (mark === "D") spans.push({ start: offset, end: offset + 1, face: "error" })
    }
    if (line.length > 2 && line[2] === "d") {
      spans.push({ start: offset + NAME_OFFSET, end: offset + line.length, face: "directory" })
    }
    offset += line.length + 1
  }
  return spans
}

export function diredMarkEntry(buffer: BufferModel, entry: DiredEntry | undefined, mark: DiredMark): void {
  if (!entry || diredSpecialEntry(entry)) return
  const marks = diredMarks.get(buffer) ?? new Map()
  marks.set(entry.path, mark)
  diredMarks.set(buffer, marks)
  renderDiredBuffer(buffer, diredEntryLines.get(buffer) ?? [])
}

export function diredUnmarkEntry(buffer: BufferModel, entry: DiredEntry | undefined): void {
  if (!entry) return
  diredMarks.get(buffer)?.delete(entry.path)
  renderDiredBuffer(buffer, diredEntryLines.get(buffer) ?? [])
}

export function diredUnmarkAll(buffer: BufferModel): void {
  diredMarks.get(buffer)?.clear()
  renderDiredBuffer(buffer, diredEntryLines.get(buffer) ?? [])
}

export function diredToggleMark(buffer: BufferModel, entry: DiredEntry | undefined): void {
  if (!entry || diredSpecialEntry(entry)) return
  const marks = diredMarks.get(buffer)
  if (marks?.get(entry.path) === "marked") diredUnmarkEntry(buffer, entry)
  else diredMarkEntry(buffer, entry, "marked")
}

export function diredMarkAll(buffer: BufferModel): void {
  const marks = diredMarks.get(buffer) ?? new Map()
  for (const entry of diredEntryLines.get(buffer) ?? []) {
    if (!diredSpecialEntry(entry)) marks.set(entry.path, "marked")
  }
  diredMarks.set(buffer, marks)
  renderDiredBuffer(buffer, diredEntryLines.get(buffer) ?? [])
}

export function diredMarkFilesRegexp(buffer: BufferModel, regexp: string, mark: DiredMark): number {
  const re = new RegExp(regexp)
  const marks = diredMarks.get(buffer) ?? new Map()
  let count = 0
  for (const entry of diredEntryLines.get(buffer) ?? []) {
    if (diredSpecialEntry(entry)) continue
    if (!re.test(entry.name)) continue
    marks.set(entry.path, mark)
    count++
  }
  diredMarks.set(buffer, marks)
  renderDiredBuffer(buffer, diredEntryLines.get(buffer) ?? [])
  return count
}

export function diredOperateEntries(buffer: BufferModel, mark: DiredMark, prefixArgument: number | null): DiredEntry[] {
  const entries = diredEntryLines.get(buffer) ?? []
  const marked = entries.filter(entry => diredMarks.get(buffer)?.get(entry.path) === mark && !diredSpecialEntry(entry))
  if (marked.length) return marked
  const count = Math.max(1, Math.abs(prefixArgument ?? 1))
  const start = entries.findIndex(entry => entry === diredEntryAtPoint(buffer))
  if (start < 0) return []
  const slice = prefixArgument != null && prefixArgument < 0
    ? entries.slice(Math.max(HEADER_LINES, start - count + 1), start + 1)
    : entries.slice(start, start + count)
  return slice.filter(entry => !diredSpecialEntry(entry))
}

export function diredFlaggedEntries(buffer: BufferModel): DiredEntry[] {
  return (diredEntryLines.get(buffer) ?? []).filter(entry => diredMarks.get(buffer)?.get(entry.path) === "delete" && !diredSpecialEntry(entry))
}

export async function diredDoFlaggedDelete(editor: Editor, buffer: BufferModel): Promise<void> {
  const flagged = diredFlaggedEntries(buffer)
  if (!flagged.length) {
    editor.message("No files flagged for deletion")
    return
  }
  const answer = await editor.prompt(`Delete ${flagged.length} flagged file(s)? (yes/no): `, "no", "dired-delete")
  if (answer?.toLowerCase() !== "yes") {
    editor.message("Cancelled")
    return
  }
  await diredRemoveEntries(editor, buffer, flagged)
  for (const entry of flagged) diredMarks.get(buffer)?.delete(entry.path)
  await refreshDiredBuffer(buffer)
  editor.message(`Deleted ${flagged.length} file(s)`)
}

export async function diredDoDelete(editor: Editor, buffer: BufferModel, prefixArgument: number | null): Promise<void> {
  const entries = diredOperateEntries(buffer, "marked", prefixArgument)
  if (!entries.length) {
    editor.message("No file to delete")
    return
  }
  const answer = await editor.prompt(`Delete ${entries.length} file(s)? (yes/no): `, "no", "dired-delete")
  if (answer?.toLowerCase() !== "yes") {
    editor.message("Cancelled")
    return
  }
  await diredRemoveEntries(editor, buffer, entries)
  await refreshDiredBuffer(buffer)
  editor.message(`Deleted ${entries.length} file(s)`)
}

export async function diredDoCopy(editor: Editor, buffer: BufferModel, prefixArgument: number | null): Promise<void> {
  const entries = diredOperateEntries(buffer, "marked", prefixArgument)
  if (!entries.length) {
    editor.message("No files to copy")
    return
  }
  const target = await editor.completingRead("Copy to: ", {
    completion: "file",
    history: "file",
    initialValue: buffer.path ?? process.cwd(),
  })
  if (!target) return
  const destDir = resolve(target)
  await mkdir(destDir, { recursive: true })
  for (const entry of entries) {
    const dest = join(destDir, basename(entry.path))
    await cp(entry.path, dest, { recursive: entry.isDirectory, force: true })
  }
  await refreshDiredBuffer(buffer)
  editor.message(`Copied ${entries.length} file(s) to ${destDir}`)
}

export async function diredDoRename(editor: Editor, buffer: BufferModel, prefixArgument: number | null): Promise<void> {
  const entries = diredOperateEntries(buffer, "marked", prefixArgument)
  if (!entries.length) {
    editor.message("No file to rename")
    return
  }
  if (entries.length === 1) {
    const entry = entries[0]!
    const target = await editor.prompt("Rename to: ", entry.name, "dired-rename")
    if (!target || target === entry.name) return
    const dest = join(dirname(entry.path), target)
    await rename(entry.path, dest)
    await refreshDiredBuffer(buffer)
    editor.message(`Renamed to ${basename(dest)}`)
    return
  }
  const target = await editor.completingRead("Move marked files to: ", {
    completion: "file",
    history: "file",
    initialValue: buffer.path ?? process.cwd(),
  })
  if (!target) return
  const destDir = resolve(target)
  await mkdir(destDir, { recursive: true })
  for (const entry of entries) {
    await rename(entry.path, join(destDir, basename(entry.path)))
  }
  await refreshDiredBuffer(buffer)
  editor.message(`Moved ${entries.length} file(s) to ${destDir}`)
}

export async function diredCreateDirectory(editor: Editor, buffer: BufferModel): Promise<void> {
  if (!buffer.path) return
  const name = await editor.prompt("Create directory: ", "", "dired-mkdir")
  if (!name) return
  const path = join(buffer.path, name)
  await mkdir(path, { recursive: true })
  await refreshDiredBuffer(buffer)
  editor.message(`Created ${path}`)
}

export function diredFlagFileDeletion(buffer: BufferModel, entry: DiredEntry | undefined): void {
  if (!entry || diredSpecialEntry(entry)) return
  diredMarkEntry(buffer, entry, "delete")
  buffer.moveLine(1)
}

export function diredUnmarkBackward(buffer: BufferModel): void {
  const lineNo = buffer.text.slice(0, buffer.point).split("\n").length - 1
  if (lineNo <= HEADER_LINES) return
  const entries = diredEntryLines.get(buffer) ?? []
  const index = lineNo - HEADER_LINES
  const previous = entries[Math.max(0, index - 1)]
  if (previous) diredUnmarkEntry(buffer, previous)
  buffer.moveLine(-1)
}

function renderDiredBuffer(buffer: BufferModel, entries: DiredEntry[]): void {
  const marks = diredMarks.get(buffer) ?? new Map()
  const lines = [`  Directory ${buffer.path}`, "", ...entries.map(entry => formatEntry(entry, marks.get(entry.path)))]
  const entryPath = diredEntryAtPoint(buffer)?.path
  const wasReadOnly = buffer.readOnly
  buffer.readOnly = false
  buffer.setText(lines.join("\n"), false)
  if (entryPath) {
    const index = entries.findIndex(entry => entry.path === entryPath)
    if (index >= 0) {
      let offset = 0
      const rendered = lines
      for (let i = 0; i < HEADER_LINES + index; i++) offset += rendered[i]!.length + 1
      buffer.point = offset + NAME_OFFSET
    }
  } else {
    buffer.point = Math.min(buffer.point, buffer.text.length)
  }
  buffer.dirty = false
  buffer.readOnly = wasReadOnly
}

function formatEntry(entry: DiredEntry, mark?: DiredMark): string {
  const markChar = mark === "delete" ? "D" : mark === "marked" ? "*" : "-"
  const type = entry.isDirectory ? "d" : "-"
  const size = entry.isDirectory ? "     " : entry.size.toString().padStart(5)
  const date = entry.mtime.toISOString().slice(0, 10)
  const name = entry.name + (entry.isDirectory && !entry.name.endsWith("/") ? "/" : "")
  return `${markChar} ${type} ${size} ${date}  ${name}`
}

async function diredRemoveEntries(editor: Editor, buffer: BufferModel, entries: DiredEntry[]): Promise<void> {
  for (const entry of entries) {
    if (diredSpecialEntry(entry)) continue
    await rm(entry.path, { recursive: entry.isDirectory, force: true })
  }
  void editor
  void buffer
}

function diredSpecialEntry(entry: DiredEntry): boolean {
  return entry.name === "." || entry.name === ".."
}

async function entryFor(parent: string, name: string): Promise<DiredEntry> {
  const path = name === "." ? parent : name === ".." ? parent : join(parent, name)
  const info = await stat(path)
  return { name, path, isDirectory: info.isDirectory(), size: info.size, mtime: info.mtime }
}
