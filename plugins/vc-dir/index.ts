import { dirname, join, resolve } from "node:path"
import { stat } from "node:fs/promises"
import { BufferModel } from "../../src/kernel/buffer"
import type { Editor } from "../../src/kernel/editor"
import { Keymap } from "../../src/kernel/keymap"
import { defineMode } from "../../src/modes/mode"
import { defvar } from "../../src/runtime/custom"
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
import { runGitLogged } from "../magit/process"

export type VcFileState = "edited" | "added" | "removed" | "untracked" | "conflict"
export type VcFileStatus = {
  file: string
  state: VcFileState
  xy: string
}
type Awaitable<T> = T | Promise<T>
export type VcStatusProvider = (root: string) => Awaitable<VcFileStatus[]>
export type VcBackend = {
  root(start: string): Promise<string | null>
  status(root: string): Promise<VcFileStatus[]>
  diff(root: string, file: string): Promise<string>
  add(root: string, files: string[]): Promise<{ code: number | null; err: string }>
}

type VcDirState = {
  root: string
  files: VcFileStatus[]
  marks: Set<string>
}

type BackendOverride = {
  active: boolean
  backend: VcBackend | null
}

export const VC_DIR_STATE_LOCAL = "vc-dir-state"

const BUFFER_NAME = "*vc-dir*"
const DIFF_BUFFER_NAME = "*vc-diff*"
const HEADER_LINES = 1
const backendOverride = defvar<BackendOverride>("vc-dir--backend-override",
  { active: false, backend: null },
  "Test seam for overriding the VC backend.", "vc-dir").value

const columns: TabulatedListColumn[] = [
  { name: "mark", width: 1 },
  { name: "state", width: 10, sortable: true },
  { name: "file", width: 64, sortable: true },
]

export function setVcBackend(backend: VcBackend | VcStatusProvider | null | undefined): void {
  if (backend === undefined) {
    backendOverride.active = false
    backendOverride.backend = null
    return
  }
  backendOverride.active = true
  backendOverride.backend = typeof backend === "function" ? statusProviderBackend(backend) : backend
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  installTabulatedList(editor, ctx)

  const keymap = new Keymap("vc-dir-mode-map")
  for (const key of ["n", "C-n", "down"]) keymap.bind(key, "next-line")
  for (const key of ["p", "C-p", "up"]) keymap.bind(key, "previous-line")
  keymap.bind("m", "vc-dir-mark")
  keymap.bind("u", "vc-dir-unmark")
  keymap.bind("enter", "vc-dir-find-file")
  keymap.bind("return", "vc-dir-find-file")
  keymap.bind("C-m", "vc-dir-find-file")
  keymap.bind("g", "tabulated-list-revert")
  keymap.bind("=", "vc-dir-diff")
  keymap.bind("v", "vc-next-action")

  defineMode({
    name: "vc-dir-mode",
    parent: "tabulated-list-mode",
    keymap,
    onEnter: buffer => { buffer.readOnly = true },
  })

  ctx.command("vc-dir", async ({ editor, buffer, args }) => {
    const start = await startingDirectory(args[0] ?? buffer.directory() ?? process.cwd())
    const root = await currentBackend().root(start)
    if (!root) {
      editor.message("Not inside a Git repository")
      return
    }
    await showVcDir(editor, root)
  }, "Show the VC status for interesting files in and below DIR.")

  ctx.command("vc-dir-mark", ({ editor, buffer }) => {
    markCurrentFile(editor, buffer, true)
  }, "Mark the file at point in VC-Dir.")

  ctx.command("vc-dir-unmark", ({ editor, buffer }) => {
    markCurrentFile(editor, buffer, false)
  }, "Unmark the file at point in VC-Dir.")

  ctx.command("vc-dir-find-file", async ({ editor, buffer }) => {
    const entry = fileAtPoint(buffer)
    const state = vcDirState(buffer)
    if (!entry || !state) {
      editor.message("No file on this line")
      return
    }
    try {
      await editor.openFile(join(state.root, entry.file))
    } catch (err) {
      editor.message((err as Error).message)
    }
  }, "Visit the file at point in VC-Dir.")

  ctx.command("vc-dir-diff", async ({ editor, buffer }) => {
    const entry = fileAtPoint(buffer)
    const state = vcDirState(buffer)
    if (!entry || !state) {
      editor.message("No file on this line")
      return
    }
    try {
      const diff = await currentBackend().diff(state.root, entry.file)
      const diffBuffer = editor.scratch(DIFF_BUFFER_NAME, diff, "diff-mode")
      diffBuffer.locals.set("vc-dir-root", state.root)
      diffBuffer.locals.set("vc-dir-file", entry.file)
    } catch (err) {
      editor.message((err as Error).message)
    }
  }, "Show the diff for the file at point in VC-Dir.")

  ctx.command("vc-next-action", async ({ editor, buffer }) => {
    await stageCurrentFiles(editor, buffer)
  }, "Perform the next logical VC action for the marked files.")
}

export async function showVcDir(editor: Editor, root: string): Promise<BufferModel> {
  const resolvedRoot = resolve(root)
  const existing = [...editor.buffers.values()].find(buffer => buffer.name === BUFFER_NAME)
  const buffer = existing ?? new BufferModel({ name: BUFFER_NAME, kind: "scratch", mode: "vc-dir-mode" })
  if (!existing) editor.addBuffer(buffer)
  editor.enterMode(buffer, "vc-dir-mode")
  const state = ensureVcDirState(buffer, resolvedRoot)
  state.root = resolvedRoot
  buffer.locals.set(TABULATED_LIST_REVERT_LOCAL, () => refreshVcDir(editor, buffer))
  await refreshVcDir(editor, buffer)
  if (buffer.lineAt(buffer.point) === 0 && tabulatedListState(buffer)?.entries.length) {
    buffer.point = buffer.lineStarts[1] ?? buffer.point
  }
  editor.switchToBuffer(buffer.id)
  void editor.changed("vc-dir")
  return buffer
}

export async function refreshVcDir(editor: Editor, buffer: BufferModel): Promise<void> {
  const state = vcDirState(buffer)
  if (!state) return
  try {
    state.files = await currentBackend().status(state.root)
    pruneMarks(state)
    renderVcDir(buffer)
  } catch (err) {
    editor.message((err as Error).message)
  }
}

export function vcDirState(buffer: BufferModel): VcDirState | null {
  return (buffer.locals.get(VC_DIR_STATE_LOCAL) as VcDirState | undefined) ?? null
}

export function parsePorcelainV1(out: string): VcFileStatus[] {
  const files: VcFileStatus[] = []
  for (const line of out.split("\n")) {
    if (!line || line.length < 3) continue
    const xy = line.slice(0, 2)
    if (xy === "!!") continue
    const file = parsePorcelainPath(line.slice(3))
    const state = stateForXY(xy)
    if (file && state) files.push({ file, state, xy })
  }
  return files
}

function currentBackend(): VcBackend {
  return backendOverride.active ? backendOverride.backend ?? nullBackend : defaultBackend
}

const defaultBackend: VcBackend = {
  async root(start) {
    try {
      const { out, code } = await runGitLogged(["rev-parse", "--show-toplevel"], start)
      return code === 0 ? trimOrNull(out) : null
    } catch {
      return null
    }
  },
  async status(root) {
    const { out, err, code } = await runGitLogged(["status", "--porcelain=v1"], root)
    if (code !== 0) throw new Error(err.trim() || "git status failed")
    return parsePorcelainV1(out)
  },
  async diff(root, file) {
    const { out, err, code } = await runGitLogged(["diff", "--", file], root)
    if (code !== 0) throw new Error(err.trim() || `git diff failed for ${file}`)
    return out
  },
  async add(root, files) {
    const { err, code } = await runGitLogged(["add", "--", ...files], root)
    return { code, err }
  },
}

const nullBackend: VcBackend = {
  root: async () => null,
  status: async () => [],
  diff: async () => "",
  add: async () => ({ code: 1, err: "No VC backend" }),
}

function statusProviderBackend(provider: VcStatusProvider): VcBackend {
  return {
    root: async start => resolve(start),
    status: async root => provider(root),
    diff: async () => "",
    add: async () => ({ code: 1, err: "No VC backend add implementation" }),
  }
}

async function startingDirectory(path: string): Promise<string> {
  const full = resolve(path)
  try {
    const st = await stat(full)
    return st.isDirectory() ? full : dirname(full)
  } catch {
    return full
  }
}

function ensureVcDirState(buffer: BufferModel, root: string): VcDirState {
  let state = vcDirState(buffer)
  if (!state) {
    state = { root, files: [], marks: new Set() }
    buffer.locals.set(VC_DIR_STATE_LOCAL, state)
  }
  return state
}

function renderVcDir(buffer: BufferModel): void {
  const state = vcDirState(buffer)
  if (!state) return
  const previousTable = tabulatedListState(buffer)
  const entries: TabulatedListEntry[] = state.files.map(file => ({
    id: file.file,
    marked: state.marks.has(file.file),
    cells: [
      state.marks.has(file.file) ? "*" : " ",
      file.state,
      file.file,
    ],
  }))
  renderTabulatedList(buffer, {
    columns,
    entries,
    sortColumn: previousTable?.sortColumn ?? "file",
    sortReverse: previousTable?.sortReverse,
  })
}

function fileAtPoint(buffer: BufferModel): VcFileStatus | null {
  const entry = tabulatedListEntryAtPoint(buffer)
  const state = vcDirState(buffer)
  if (!entry || !state) return null
  return state.files.find(file => file.file === entry.id) ?? null
}

function markCurrentFile(editor: Editor, buffer: BufferModel, marked: boolean): void {
  const entry = fileAtPoint(buffer)
  const state = vcDirState(buffer)
  if (!entry || !state) return
  const line = buffer.lineAt(buffer.point)
  if (marked) state.marks.add(entry.file)
  else state.marks.delete(entry.file)
  renderVcDir(buffer)
  moveToListLine(buffer, line + 1)
  void editor.changed(marked ? "vc-dir-mark" : "vc-dir-unmark")
}

async function stageCurrentFiles(editor: Editor, buffer: BufferModel): Promise<void> {
  const state = vcDirState(buffer)
  if (!state) {
    editor.message("Not in a VC-Dir buffer")
    return
  }
  const targets = targetFiles(buffer, state)
  if (!targets.length) {
    editor.message("No file on this line")
    return
  }
  const stageable = targets.filter(file => file.state === "edited" || file.state === "untracked")
  if (!stageable.length) {
    editor.message("No edited or untracked files to stage")
    return
  }
  const files = stageable.map(file => file.file)
  const result = await currentBackend().add(state.root, files)
  if (result.code !== 0) {
    editor.message(result.err.trim() || "git add failed")
    return
  }
  for (const file of files) state.marks.delete(file)
  await refreshVcDir(editor, buffer)
  editor.message(`Staged ${files.length} file${files.length === 1 ? "" : "s"}`)
}

function targetFiles(buffer: BufferModel, state: VcDirState): VcFileStatus[] {
  const marked = state.files.filter(file => state.marks.has(file.file))
  if (marked.length) return marked
  const current = fileAtPoint(buffer)
  return current ? [current] : []
}

function moveToListLine(buffer: BufferModel, line: number): void {
  const state = tabulatedListState(buffer)
  const maxLine = state?.entries.length ?? 0
  const next = Math.max(1, Math.min(line, maxLine))
  buffer.point = buffer.lineStarts[next] ?? buffer.point
}

function pruneMarks(state: VcDirState): void {
  const files = new Set(state.files.map(file => file.file))
  for (const file of [...state.marks]) {
    if (!files.has(file)) state.marks.delete(file)
  }
}

function stateForXY(xy: string): VcFileState | null {
  if (xy === "??") return "untracked"
  if (isConflictXY(xy)) return "conflict"
  if (xy.includes("D")) return "removed"
  if (xy.includes("A")) return "added"
  return "edited"
}

function isConflictXY(xy: string): boolean {
  return xy === "DD" || xy === "AU" || xy === "UD" || xy === "UA"
    || xy === "DU" || xy === "AA" || xy === "UU" || xy.includes("U")
}

function parsePorcelainPath(raw: string): string {
  const renamed = raw.includes(" -> ") ? raw.slice(raw.lastIndexOf(" -> ") + 4) : raw
  return unquoteGitPath(renamed)
}

function unquoteGitPath(path: string): string {
  if (!path.startsWith("\"") || !path.endsWith("\"")) return path
  try {
    const parsed = JSON.parse(path) as unknown
    return typeof parsed === "string" ? parsed : path
  } catch {
    return path.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\")
  }
}

function trimOrNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}
