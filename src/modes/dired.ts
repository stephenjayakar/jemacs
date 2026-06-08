import { basename, dirname, join, resolve } from "node:path"
import { cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises"
import type { Editor } from "../kernel/editor"
import { expandUserPath } from "../kernel/completion"
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

export const diredEntryLines = new WeakMap<BufferModel, DiredEntry[]>()
const diredMarks = new WeakMap<BufferModel, Map<string, DiredMark>>()

export const HEADER_LINES = 2
export const NAME_OFFSET = 22

export function installDiredMode(): void {
  const keymap = new Keymap("dired-map")
  keymap.bind("enter", "dired-find-file")
  keymap.bind("g", "revert-buffer")
  keymap.bind("^", "dired-up-directory")
  keymap.bind("q", "quit-window")
  keymap.bind("m", "dired-mark")
  keymap.bind("u", "dired-unmark")
  keymap.bind("S-u", "dired-unmark-all-marks")
  keymap.bind("t", "dired-toggle-marks")
  keymap.bind("* %", "dired-mark-files-regexp")
  keymap.bind("% m", "dired-mark-files-regexp")
  keymap.bind("% d", "dired-flag-files-regexp")
  keymap.bind("d", "dired-flag-file-deletion")
  keymap.bind("x", "dired-do-flagged-delete")
  keymap.bind("S-d", "dired-do-delete")
  keymap.bind("S-c", "dired-do-copy")
  keymap.bind("S-r", "dired-do-rename")
  keymap.bind("+", "dired-create-directory")
  keymap.bind("backspace", "dired-unmark-backward")
  defineMode({ name: "dired", parent: "text", keymap, fontLock: diredFontLock })
}

export async function makeDiredBuffer(path: string): Promise<BufferModel> {
  let dir = resolve(path)
  // fido file-completion can resolve to a file; visit its parent rather than
  // letting readdir throw ENOTDIR (matches Emacs `dired` on a file path).
  const info = await stat(dir).catch(() => null)
  if (info && !info.isDirectory()) dir = dirname(dir)
  const buffer = new BufferModel({ name: `${basename(dir) || dir}/`, path: dir, kind: "directory", mode: "dired" })
  buffer.readOnly = true
  diredMarks.set(buffer, new Map())
  await refreshDiredBuffer(buffer)
  return buffer
}

/** Entry point for the `dired` command: stat PATH and open it as a dired
 *  listing (or visit it as a file). Reports fs errors via `editor.message`
 *  instead of letting them propagate. */
export async function diredOpen(editor: Editor, path: string): Promise<void> {
  const full = resolve(expandUserPath(path))
  try {
    const info = await stat(full)
    if (info.isDirectory()) await editor.openDirectory(full)
    else await editor.openFile(full)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    editor.message(`${full}: ${code === "ENOTDIR" ? "Not a directory" : (err as Error).message}`)
  }
}

export async function refreshDiredBuffer(buffer: BufferModel): Promise<void> {
  if (!buffer.path) throw new Error(`Dired buffer ${buffer.name} has no directory path`)
  const previousMarks = diredMarks.get(buffer) ?? new Map()
  const names = await readdir(buffer.path)
  const entries: DiredEntry[] = []
  for (const name of ["..", ...names.sort((a, b) => a.localeCompare(b))]) {
    const entry = await entryFor(buffer.path, name)
    if (entry) entries.push(entry)
  }

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

function markMatches(mark: DiredMark, markChar?: string): boolean {
  if (!markChar) return true
  if (markChar === "*") return mark === "marked"
  if (markChar === "D") return mark === "delete"
  return false
}

export async function diredUnmarkAllFiles(
  buffer: BufferModel,
  markChar?: string,
  confirm?: (entry: DiredEntry, mark: DiredMark) => Promise<boolean>,
): Promise<number> {
  const marks = diredMarks.get(buffer)
  if (!marks) return 0
  let count = 0
  for (const entry of diredEntryLines.get(buffer) ?? []) {
    const mark = marks.get(entry.path)
    if (!mark || !markMatches(mark, markChar)) continue
    if (confirm && !await confirm(entry, mark)) continue
    marks.delete(entry.path)
    count++
  }
  renderDiredBuffer(buffer, diredEntryLines.get(buffer) ?? [])
  return count
}

export function diredToggleMark(buffer: BufferModel, entry: DiredEntry | undefined): void {
  if (!entry || diredSpecialEntry(entry)) return
  const marks = diredMarks.get(buffer)
  if (marks?.get(entry.path) === "marked") diredUnmarkEntry(buffer, entry)
  else diredMarkEntry(buffer, entry, "marked")
}

export function diredToggleMarks(buffer: BufferModel): void {
  const marks = diredMarks.get(buffer) ?? new Map()
  for (const entry of diredEntryLines.get(buffer) ?? []) {
    if (diredSpecialEntry(entry)) continue
    if (marks.get(entry.path) === "marked") marks.delete(entry.path)
    else if (!marks.has(entry.path)) marks.set(entry.path, "marked")
  }
  diredMarks.set(buffer, marks)
  renderDiredBuffer(buffer, diredEntryLines.get(buffer) ?? [])
}

export function diredMarkAll(buffer: BufferModel): void {
  const marks = diredMarks.get(buffer) ?? new Map()
  for (const entry of diredEntryLines.get(buffer) ?? []) {
    if (!diredSpecialEntry(entry)) marks.set(entry.path, "marked")
  }
  diredMarks.set(buffer, marks)
  renderDiredBuffer(buffer, diredEntryLines.get(buffer) ?? [])
}

export function diredMarkFilesRegexp(buffer: BufferModel, regexp: string, mark: DiredMark, editor?: Editor): number {
  let re: RegExp
  try {
    re = new RegExp(regexp)
  } catch (err) {
    editor?.message(`Invalid regexp: ${(err as SyntaxError).message}`)
    return 0
  }
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
  const failed: { entry: DiredEntry; err: Error }[] = []
  let ok = 0
  try {
    for (const entry of entries) {
      try {
        await cp(entry.path, join(destDir, basename(entry.path)), { recursive: entry.isDirectory, force: true })
        ok++
      } catch (err) {
        failed.push({ entry, err: err as Error })
      }
    }
  } finally {
    await refreshDiredBuffer(buffer)
    editor.message(`Copied ${ok} file(s) to ${destDir}${formatFailures(failed)}`)
  }
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
  const failed: { entry: DiredEntry; err: Error }[] = []
  let ok = 0
  try {
    for (const entry of entries) {
      try {
        await rename(entry.path, join(destDir, basename(entry.path)))
        ok++
      } catch (err) {
        failed.push({ entry, err: err as Error })
      }
    }
  } finally {
    await refreshDiredBuffer(buffer)
    editor.message(`Moved ${ok} file(s) to ${destDir}${formatFailures(failed)}`)
  }
}

/** GNU `make-directory`: create DIR under PARENT (interactive prompt when NAME omitted). */
export async function makeDirectory(
  editor: Editor,
  parent: string,
  name?: string,
  refresh?: BufferModel,
): Promise<string | null> {
  const dirName = name?.trim() || await editor.prompt("Make directory: ", "", "make-directory")
  if (!dirName?.trim()) return null
  const path = resolve(parent, expandUserPath(dirName.trim()))
  await mkdir(path, { recursive: true })
  if (refresh?.kind === "directory" && refresh.path) await refreshDiredBuffer(refresh)
  editor.message(`Created ${path}`)
  return path
}

export async function diredCreateDirectory(editor: Editor, buffer: BufferModel, name?: string): Promise<void> {
  if (!buffer.path) return
  await makeDirectory(editor, buffer.path, name, buffer)
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
      buffer.point = diredNamePoint(lines, index)
    }
  } else {
    const firstFile = entries.findIndex(entry => !diredSpecialEntry(entry))
    if (firstFile >= 0) buffer.point = diredNamePoint(lines, firstFile)
    else buffer.point = Math.min(buffer.point, buffer.text.length)
  }
  buffer.dirty = false
  buffer.readOnly = wasReadOnly
}

function diredNamePoint(lines: string[], entryIndex: number): number {
  let offset = 0
  for (let i = 0; i < HEADER_LINES + entryIndex; i++) offset += lines[i]!.length + 1
  return offset + NAME_OFFSET
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

function formatFailures(failed: { entry: DiredEntry; err: Error }[]): string {
  if (!failed.length) return ""
  const detail = failed.map(f => `${f.entry.name} [${(f.err as NodeJS.ErrnoException).code ?? f.err.message}]`).join(", ")
  return ` (${failed.length} failed: ${detail})`
}

function diredSpecialEntry(entry: DiredEntry): boolean {
  return entry.name === "." || entry.name === ".."
}

async function entryFor(parent: string, name: string): Promise<DiredEntry | null> {
  const path = name === "." ? parent : name === ".." ? dirname(parent) : join(parent, name)
  try {
    const info = await stat(path)
    return { name, path, isDirectory: info.isDirectory(), size: info.size, mtime: info.mtime }
  } catch {
    return null
  }
}
