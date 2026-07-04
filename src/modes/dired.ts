import { basename, dirname, join, resolve } from "node:path"
import { chmod, cp, cwd, isDirectory, isSymbolicLink, link, lstat, mkdir, readdir, readlink, rename, rm, spawnProcess, stat, symlink, utimes } from "../platform/runtime"
import type { Editor } from "../kernel/editor"
import { expandUserPath } from "../kernel/completion"
import { BufferModel } from "../kernel/buffer"
import { Keymap } from "../kernel/keymap"
import { defineMode, type TextSpan } from "./mode"

export type DiredEntry = {
  name: string
  path: string
  isDirectory: boolean
  isSymlink?: boolean
  mode?: number
  linkTarget?: string
  size: number
  mtime: Date
}

export type DiredMark = "marked" | "delete"
type DiredSortOrder = "name" | "date"
export type DiredFileOps = {
  listDirectory(path: string): Promise<DiredEntry[]>
  deleteFile(path: string, recursive?: boolean): Promise<void>
  copyFile(from: string, to: string, recursive?: boolean): Promise<void>
  rename(from: string, to: string): Promise<void>
  mkdir(path: string): Promise<void>
  touch(path: string, mtime: Date): Promise<void>
}

export const diredEntryLines = new WeakMap<BufferModel, DiredEntry[]>()
const diredMarks = new WeakMap<BufferModel, Map<string, DiredMark>>()
const diredSortOrders = new WeakMap<BufferModel, DiredSortOrder>()

export const HEADER_LINES = 2
export const NAME_OFFSET = 31

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
  keymap.bind("S-m", "dired-do-chmod")
  keymap.bind("S-t", "dired-do-touch")
  keymap.bind("S-s", "dired-do-symlink")
  keymap.bind("S-h", "dired-do-hardlink")
  keymap.bind("!", "dired-do-shell-command")
  keymap.bind("s", "dired-sort-toggle-or-edit")
  keymap.bind("+", "dired-create-directory")
  keymap.bind("backspace", "dired-unmark-backward")
  defineMode({ name: "dired", parent: "text", keymap, fontLock: diredFontLock })
}

export async function makeDiredBuffer(path: string): Promise<BufferModel> {
  let dir = resolve(path)
  // fido file-completion can resolve to a file; visit its parent rather than
  // letting readdir throw ENOTDIR (matches Emacs `dired` on a file path).
  const info = await stat(dir)
  if (info && !isDirectory(info)) dir = dirname(dir)
  const buffer = new BufferModel({ name: `${basename(dir) || dir}/`, path: dir, kind: "directory", mode: "dired" })
  buffer.readOnly = true
  diredMarks.set(buffer, new Map())
  diredSortOrders.set(buffer, "name")
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
    if (!info) {
      // Platform stat() folds ENOENT/ENOTDIR to null; recover the ENOTDIR case
      // by checking whether the parent component is a regular file.
      const parent = await stat(dirname(full))
      editor.message(`${full}: ${parent && !isDirectory(parent) ? "Not a directory" : "No such file or directory"}`)
      return
    }
    if (isDirectory(info)) await editor.openDirectory(full)
    else await editor.openFile(full)
  } catch (err) {
    editor.message(`${full}: ${(err as Error).message}`)
  }
}

export async function refreshDiredBuffer(buffer: BufferModel): Promise<void> {
  if (!buffer.path) throw new Error(`Dired buffer ${buffer.name} has no directory path`)
  const previousMarks = diredMarks.get(buffer) ?? new Map()
  const order = diredSortOrders.get(buffer) ?? "name"
  const allEntries = await diredFileOps(buffer).listDirectory(buffer.path)
  const parentEntries = allEntries.filter(diredSpecialEntry)
  const childEntries = allEntries.filter(entry => !diredSpecialEntry(entry))
  childEntries.sort(order === "date"
    ? (a, b) => b.mtime.getTime() - a.mtime.getTime() || a.name.localeCompare(b.name)
    : (a, b) => a.name.localeCompare(b.name))
  const entries: DiredEntry[] = [...parentEntries, ...childEntries]

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

function markFromChar(markChar?: string): DiredMark | null | undefined {
  if (markChar === "*") return "marked"
  if (markChar === "D") return "delete"
  if (markChar === "-" || markChar === " " || markChar === "") return null
  return undefined
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

export function diredChangeMarks(buffer: BufferModel, oldChar: string, newChar: string): number {
  const oldMark = markFromChar(oldChar)
  const newMark = markFromChar(newChar)
  if (oldMark === undefined || newMark === undefined) return 0
  const marks = diredMarks.get(buffer) ?? new Map()
  let count = 0
  for (const entry of diredEntryLines.get(buffer) ?? []) {
    if (diredSpecialEntry(entry)) continue
    const current = marks.get(entry.path) ?? null
    if (current !== oldMark) continue
    if (newMark) marks.set(entry.path, newMark)
    else marks.delete(entry.path)
    count++
  }
  diredMarks.set(buffer, marks)
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

export function diredEntriesForPrefix(buffer: BufferModel, prefixArgument: number | null): DiredEntry[] {
  const entries = diredEntryLines.get(buffer) ?? []
  const current = diredEntryAtPoint(buffer)
  const start = current ? entries.findIndex(entry => entry === current) : -1
  if (start < 0) return []
  const count = Math.max(1, Math.abs(prefixArgument ?? 1))
  const selected = prefixArgument != null && prefixArgument < 0
    ? entries.slice(Math.max(0, start - count + 1), start + 1)
    : entries.slice(start, start + count)
  return selected.filter(entry => !diredSpecialEntry(entry))
}

export function diredMarkedFilesSummary(buffer: BufferModel): { count: number; totalSize: number } {
  const marks = diredMarks.get(buffer)
  let count = 0
  let totalSize = 0
  for (const entry of diredEntryLines.get(buffer) ?? []) {
    if (marks?.get(entry.path) !== "marked" || diredSpecialEntry(entry)) continue
    count++
    totalSize += entry.size
  }
  return { count, totalSize }
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
    initialValue: buffer.path ?? cwd(),
  })
  if (!target) return
  const ops = diredFileOps(buffer)
  const destDir = diredResolve(target)
  await ops.mkdir(destDir)
  const failed: { entry: DiredEntry; err: Error }[] = []
  let ok = 0
  try {
    for (const entry of entries) {
      try {
        await ops.copyFile(entry.path, join(destDir, basename(entry.path)), entry.isDirectory)
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
    await diredFileOps(buffer).rename(entry.path, dest)
    await refreshDiredBuffer(buffer)
    editor.message(`Renamed to ${basename(dest)}`)
    return
  }
  const target = await editor.completingRead("Move marked files to: ", {
    completion: "file",
    history: "file",
    initialValue: buffer.path ?? cwd(),
  })
  if (!target) return
  const ops = diredFileOps(buffer)
  const destDir = diredResolve(target)
  await ops.mkdir(destDir)
  const failed: { entry: DiredEntry; err: Error }[] = []
  let ok = 0
  try {
    for (const entry of entries) {
      try {
        await ops.rename(entry.path, join(destDir, basename(entry.path)))
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

export async function diredDoChmod(editor: Editor, buffer: BufferModel, prefixArgument: number | null, modeArg?: string): Promise<void> {
  const entries = diredOperateEntries(buffer, "marked", prefixArgument)
  if (!entries.length) {
    editor.message("No files to chmod")
    return
  }
  const mode = modeArg ?? await editor.prompt(`Change mode of ${entries.length} files to: `, "", "dired-chmod")
  if (!mode) return
  const numeric = /^[0-7]{3,4}$/.test(mode.trim()) ? Number.parseInt(mode.trim(), 8) : null
  if (numeric != null) {
    for (const entry of entries) await chmod(entry.path, numeric)
  } else {
    await runShellCommand(`chmod ${shellQuote(mode)} ${entries.map(entry => shellQuote(entry.path)).join(" ")}`, cwd())
  }
  await refreshDiredBuffer(buffer)
  editor.message(`Changed mode of ${entries.length} file(s) to ${mode}`)
}

export async function diredDoTouch(editor: Editor, buffer: BufferModel, prefixArgument: number | null, timestampArg?: string): Promise<void> {
  const entries = diredOperateEntries(buffer, "marked", prefixArgument)
  if (!entries.length) {
    editor.message("No files to touch")
    return
  }
  const input = timestampArg ?? await editor.prompt(`Touch ${entries.length} file${entries.length === 1 ? "" : "s"} (timestamp, RET for now): `, "", "dired-touch")
  if (input == null) return
  const mtime = parseTouchTimestamp(input)
  if (!mtime) {
    editor.message(`Invalid timestamp: ${input}`)
    return
  }
  const ops = diredFileOps(buffer)
  for (const entry of entries) await ops.touch(entry.path, mtime)
  await refreshDiredBuffer(buffer)
  editor.message(`Touched ${entries.length} file(s)`)
}

export async function diredDoSymlink(editor: Editor, buffer: BufferModel, prefixArgument: number | null, targetArg?: string): Promise<void> {
  await diredDoLink(editor, buffer, prefixArgument, "symlink", targetArg)
}

export async function diredDoHardlink(editor: Editor, buffer: BufferModel, prefixArgument: number | null, targetArg?: string): Promise<void> {
  await diredDoLink(editor, buffer, prefixArgument, "hardlink", targetArg)
}

export async function diredDoShellCommand(editor: Editor, buffer: BufferModel, prefixArgument: number | null, commandArg?: string): Promise<void> {
  const entries = diredOperateEntries(buffer, "marked", prefixArgument)
  if (!entries.length) {
    editor.message("No files for shell command")
    return
  }
  const command = commandArg ?? await editor.prompt(`Shell command on ${entries.length} files: `, "", "dired-shell-command")
  if (!command) return
  const files = entries.map(entry => shellQuote(entry.name)).join(" ")
  const expanded = command.includes("*") ? command.replaceAll("*", files) : `${command} ${files}`
  const cwd = buffer.path ?? dirname(entries[0]!.path)
  const output = await runShellCommand(expanded, cwd)
  const text =
    `-*- mode: compilation; default-directory: ${JSON.stringify(cwd)} -*-\n` +
    `Shell command: ${expanded}\n\n` +
    output.text +
    (output.text.endsWith("\n") || output.text.length === 0 ? "" : "\n") +
    `\nShell command ${output.code === 0 ? "finished" : `exited abnormally with code ${output.code ?? "?"}`}\n`
  const out = editor.scratch("*Shell Command Output*", text, "compilation")
  out.readOnly = true
  out.locals.set("default-directory", cwd)
  editor.message(output.code === 0 ? "Shell command finished" : `Shell command exited abnormally with code ${output.code ?? "?"}`)
}

export async function diredSortToggleOrEdit(editor: Editor, buffer: BufferModel): Promise<void> {
  const next = diredSortOrders.get(buffer) === "date" ? "name" : "date"
  diredSortOrders.set(buffer, next)
  await refreshDiredBuffer(buffer)
  editor.message(`Dired sort by ${next}`)
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
  const path = diredResolve(parent, expandUserPath(dirName.trim()))
  await (refresh ? diredFileOps(refresh) : localDiredFileOps).mkdir(path)
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

export function renderDiredBuffer(buffer: BufferModel, entries: DiredEntry[]): void {
  const marks = diredMarks.get(buffer) ?? new Map()
  const order = diredSortOrders.get(buffer) ?? "name"
  const lines = [`  Directory ${buffer.path} (sort by ${order})`, "", ...entries.map(entry => formatEntry(entry, marks.get(entry.path)))]
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
  const mode = formatModeString(entry)
  const size = entry.isDirectory ? "     " : entry.size.toString().padStart(5)
  const date = entry.mtime.toISOString().slice(0, 10)
  const suffix = entry.isSymlink && entry.linkTarget != null
    ? ` -> ${entry.linkTarget}`
    : entry.isDirectory && !entry.name.endsWith("/") ? "/" : ""
  const name = entry.name + suffix
  return `${markChar} ${mode} ${size} ${date}  ${name}`
}

function formatModeString(entry: DiredEntry): string {
  const type = entry.isSymlink ? "l" : entry.isDirectory ? "d" : "-"
  const mode = entry.mode ?? (entry.isDirectory ? 0o755 : 0o644)
  const chars = [
    mode & 0o400 ? "r" : "-",
    mode & 0o200 ? "w" : "-",
    mode & 0o100 ? "x" : "-",
    mode & 0o040 ? "r" : "-",
    mode & 0o020 ? "w" : "-",
    mode & 0o010 ? "x" : "-",
    mode & 0o004 ? "r" : "-",
    mode & 0o002 ? "w" : "-",
    mode & 0o001 ? "x" : "-",
  ].join("")
  return `${type}${chars}`
}

async function diredRemoveEntries(editor: Editor, buffer: BufferModel, entries: DiredEntry[]): Promise<void> {
  const ops = diredFileOps(buffer)
  for (const entry of entries) {
    if (diredSpecialEntry(entry)) continue
    await ops.deleteFile(entry.path, entry.isDirectory)
  }
  void editor
  void buffer
}

const localDiredFileOps: DiredFileOps = {
  async listDirectory(path: string): Promise<DiredEntry[]> {
    const names = await readdir(path)
    const childEntries = (await Promise.all(names.map(name => entryFor(path, name))))
      .filter((entry): entry is DiredEntry => entry != null)
    const parent = await entryFor(path, "..")
    return parent ? [parent, ...childEntries] : childEntries
  },
  async deleteFile(path: string, recursive = false): Promise<void> {
    await rm(path, { recursive, force: true })
  },
  async copyFile(from: string, to: string, recursive = false): Promise<void> {
    await cp(from, to, { recursive, force: true })
  },
  async rename(from: string, to: string): Promise<void> {
    await rename(from, to)
  },
  async mkdir(path: string): Promise<void> {
    await mkdir(path, { recursive: true })
  },
  async touch(path: string, mtime: Date): Promise<void> {
    await utimes(path, mtime, mtime)
  },
}

function diredFileOps(buffer: BufferModel): DiredFileOps {
  return buffer.locals.get("dired-file-ops") as DiredFileOps | undefined ?? localDiredFileOps
}

function diredResolve(...paths: string[]): string {
  return resolve(...paths)
}

function formatFailures(failed: { entry: DiredEntry; err: Error }[]): string {
  if (!failed.length) return ""
  const detail = failed.map(f => `${f.entry.name} [${(f.err as NodeJS.ErrnoException).code ?? f.err.message}]`).join(", ")
  return ` (${failed.length} failed: ${detail})`
}

async function diredDoLink(
  editor: Editor,
  buffer: BufferModel,
  prefixArgument: number | null,
  kind: "symlink" | "hardlink",
  targetArg?: string,
): Promise<void> {
  const entries = diredOperateEntries(buffer, "marked", prefixArgument)
  if (!entries.length) {
    editor.message(`No files to ${kind}`)
    return
  }
  const prompt = entries.length === 1
    ? `${kind === "symlink" ? "Symlink" : "Hardlink"} to: `
    : `${kind === "symlink" ? "Symlink" : "Hardlink"} marked files to: `
  const target = targetArg ?? await editor.completingRead(prompt, {
    completion: "file",
    history: "file",
    initialValue: buffer.path ?? cwd(),
  })
  if (!target) return
  const destination = resolve(target)
  const destinationStat = await stat(destination)
  const useDirectory = entries.length > 1 || (destinationStat != null && isDirectory(destinationStat))
  if (entries.length > 1) await mkdir(destination, { recursive: true })
  const failed: { entry: DiredEntry; err: Error }[] = []
  let ok = 0
  try {
    for (const entry of entries) {
      const dest = useDirectory ? join(destination, basename(entry.path)) : destination
      try {
        if (kind === "symlink") await symlink(entry.path, dest)
        else await link(entry.path, dest)
        ok++
      } catch (err) {
        failed.push({ entry, err: err as Error })
      }
    }
  } finally {
    await refreshDiredBuffer(buffer)
    editor.message(`${kind === "symlink" ? "Symlinked" : "Hardlinked"} ${ok} file(s)${formatFailures(failed)}`)
  }
}

function parseTouchTimestamp(input: string): Date | null {
  const trimmed = input.trim()
  if (!trimmed) return new Date()
  const parsed = new Date(trimmed)
  if (!Number.isNaN(parsed.getTime())) return parsed
  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{2}))?$/.exec(trimmed)
  if (!compact) return null
  const [, year, month, day, hour, minute, second = "00"] = compact
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
  return Number.isNaN(date.getTime()) ? null : date
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function runShellCommand(command: string, cwd: string): Promise<{ text: string; code: number | null }> {
  const proc = spawnProcess({ cmd: ["sh", "-c", command], cwd, stdout: "pipe", stderr: "pipe" })
  let text = ""
  await Promise.all([
    pumpText(proc.stdout, chunk => { text += chunk }),
    pumpText(proc.stderr, chunk => { text += chunk }),
  ])
  return { text, code: await proc.exited }
}

async function pumpText(stream: ReadableStream<Uint8Array> | null, onChunk: (chunk: string) => void): Promise<void> {
  if (!stream) return
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value?.length) onChunk(decoder.decode(value, { stream: true }))
  }
  const tail = decoder.decode()
  if (tail) onChunk(tail)
}

function diredSpecialEntry(entry: DiredEntry): boolean {
  return entry.name === "." || entry.name === ".."
}

async function entryFor(parent: string, name: string): Promise<DiredEntry | null> {
  const path = name === "." ? parent : name === ".." ? dirname(parent) : join(parent, name)
  const [linkInfo, info] = await Promise.all([lstat(path), stat(path)])
  if (!info) return null
  const isSymlinkEntry = linkInfo != null && isSymbolicLink(linkInfo)
  let linkTarget: string | undefined
  if (isSymlinkEntry) {
    try { linkTarget = await readlink(path) } catch { /* leave target hidden if host cannot read it */ }
  }
  const displayInfo = linkInfo ?? info
  return {
    name,
    path,
    isDirectory: isDirectory(info),
    isSymlink: isSymlinkEntry,
    mode: displayInfo.mode,
    linkTarget,
    size: displayInfo.size,
    mtime: new Date(displayInfo.mtime),
  }
}
