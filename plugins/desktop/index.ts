import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { inferMode, type BufferModel } from "../../src/kernel/buffer"
import type { Editor } from "../../src/kernel/editor"
import type { RegisterContents } from "../../src/kernel/register"
import {
  createLeafWindow,
  type WindowLeaf,
  type WindowNode,
  type WindowSplit,
} from "../../src/kernel/window"
import { fileExists } from "../../src/platform/runtime"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { defcustom, getCustom, setCustom } from "../../src/runtime/custom"

export type DesktopFileEntry = {
  path: string
  point: number
  mode?: string
}

export type SerializedDesktopWindow =
  | { kind: "leaf"; path?: string; point?: number; startLine?: number; dedicated?: boolean }
  | {
    kind: "split"
    direction: WindowSplit["direction"]
    firstRatio?: number
    first: SerializedDesktopWindow
    second: SerializedDesktopWindow
  }

export type DesktopManifest = {
  version: 1
  files: DesktopFileEntry[]
  currentBuffer?: string
  layout?: SerializedDesktopWindow
}

type RestoredLayout = {
  node: WindowNode
  leaves: WindowLeaf[]
}

defcustom("desktop-save-mode", "boolean", false,
  "When non-nil, restore the saved Jemacs desktop at startup and save it on exit.", "convenience")
defcustom("desktop-save-file", "string", join(homedir(), ".jemacs", "desktop.json"),
  "File where desktop-save-mode persists the session.", "convenience")
defcustom("desktop-restore-eager",
  { kind: "choice", options: [{ const: true, tag: "All" }, { type: "natnum", tag: "Number" }] }, true,
  "Number of buffers to restore immediately; the rest restore lazily after startup.\n"
  + "t restores all buffers at once. Buffers shown in the saved window layout always\n"
  + "restore immediately, because the layout needs them.", "convenience")
defcustom("desktop-lazy-idle-delay", "number", 5,
  "Seconds to wait after a desktop read before lazy buffer restoration starts.", "convenience")

const restoredPaths = new WeakMap<Editor, Set<string>>()
/** `desktop-buffer-args-list`: entries still waiting for lazy restoration. */
const pendingEntries = new WeakMap<Editor, DesktopFileEntry[]>()
/** Each read gets a fresh token; a lazy loop whose token is stale stops. */
const lazyTokens = new WeakMap<Editor, object>()
defcustom("desktop-auto-save-timeout", "integer", 30,
  "Seconds between automatic desktop saves while desktop-save-mode is on; 0 disables.", "convenience")

const lastSaved = new WeakMap<Editor, string>()
// Editors whose after-init-hook has run. Auto-saving before then could replace
// the saved desktop with the bare startup layout before it is restored.
const initialized = new WeakSet<Editor>()

export function desktopSaveFile(): string {
  return getCustom<string>("desktop-save-file") ?? join(homedir(), ".jemacs", "desktop.json")
}

/** Most recently selected first, like the `buffer-list` order Emacs saves, so
 *  `desktop-restore-eager` keeps the buffers that were in use. */
function visitedFileBuffers(editor: Editor): BufferModel[] {
  return editor.bufferCycleOrder().filter(buffer => buffer.kind === "file" && !!buffer.path)
}

function bufferPath(editor: Editor, bufferId: string): string | undefined {
  const buffer = editor.buffers.get(bufferId)
  return buffer?.kind === "file" ? buffer.path : undefined
}

function entryForBuffer(buffer: BufferModel): DesktopFileEntry | null {
  if (buffer.kind !== "file" || !buffer.path) return null
  const entry: DesktopFileEntry = {
    path: buffer.path,
    point: buffer.point,
  }
  const inferred = inferMode(buffer.path, buffer.text)
  if (buffer.mode !== inferred) entry.mode = buffer.mode
  return entry
}

function serializeWindowLayout(editor: Editor, node: WindowNode): SerializedDesktopWindow {
  if (node.kind === "leaf") {
    const path = bufferPath(editor, node.bufferId)
    return {
      kind: "leaf",
      ...(path ? { path } : {}),
      point: node.point,
      startLine: node.startLine,
      dedicated: node.dedicated,
    }
  }
  return {
    kind: "split",
    direction: node.direction,
    ...(typeof node.firstRatio === "number" ? { firstRatio: node.firstRatio } : {}),
    first: serializeWindowLayout(editor, node.first),
    second: serializeWindowLayout(editor, node.second),
  }
}

function toPoint(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function parseWindowLayout(value: unknown): SerializedDesktopWindow | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as Record<string, unknown>
  if (raw.kind === "leaf") {
    return {
      kind: "leaf",
      ...(typeof raw.path === "string" ? { path: raw.path } : {}),
      point: toPoint(raw.point),
      startLine: toPoint(raw.startLine),
      dedicated: raw.dedicated === true,
    }
  }
  if (raw.kind !== "split") return undefined
  const first = parseWindowLayout(raw.first)
  const second = parseWindowLayout(raw.second)
  if (!first || !second) return undefined
  const direction = raw.direction === "vertical" ? "vertical" : "horizontal"
  return {
    kind: "split",
    direction,
    ...(typeof raw.firstRatio === "number" && Number.isFinite(raw.firstRatio) ? { firstRatio: raw.firstRatio } : {}),
    first,
    second,
  }
}

function parseManifest(text: string): DesktopManifest | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== "object") return null
  const data = raw as Record<string, unknown>
  const files = Array.isArray(data.files)
    ? data.files.flatMap(item => {
      if (!item || typeof item !== "object") return []
      const entry = item as Record<string, unknown>
      if (typeof entry.path !== "string") return []
      return [{
        path: entry.path,
        point: toPoint(entry.point),
        ...(typeof entry.mode === "string" ? { mode: entry.mode } : {}),
      } satisfies DesktopFileEntry]
    })
    : []
  const layout = parseWindowLayout(data.layout)
  return {
    version: 1,
    files,
    ...(typeof data.currentBuffer === "string" ? { currentBuffer: data.currentBuffer } : {}),
    ...(layout ? { layout } : {}),
  }
}

async function readDesktopManifest(): Promise<DesktopManifest | null> {
  const text = await readFile(desktopSaveFile(), "utf8").catch(() => null)
  return text ? parseManifest(text) : null
}

function clampPoint(buffer: BufferModel, point: number): number {
  return Math.max(0, Math.min(buffer.text.length, point))
}

function deserializeWindowLayout(
  node: SerializedDesktopWindow,
  buffersByPath: Map<string, BufferModel>,
): RestoredLayout | null {
  if (node.kind === "leaf") {
    if (!node.path) return null
    const buffer = buffersByPath.get(node.path)
    if (!buffer) return null
    const leaf = createLeafWindow(buffer.id, clampPoint(buffer, node.point ?? buffer.point), crypto.randomUUID(), node.startLine ?? 0)
    leaf.dedicated = node.dedicated === true
    return { node: leaf, leaves: [leaf] }
  }
  const first = deserializeWindowLayout(node.first, buffersByPath)
  const second = deserializeWindowLayout(node.second, buffersByPath)
  if (!first) return second
  if (!second) return first
  return {
    node: {
      kind: "split",
      direction: node.direction,
      ...(typeof node.firstRatio === "number" ? { firstRatio: node.firstRatio } : {}),
      first: first.node,
      second: second.node,
    },
    leaves: [...first.leaves, ...second.leaves],
  }
}

function selectLeafForCurrent(layout: RestoredLayout, currentPath: string | undefined, buffersByPath: Map<string, BufferModel>): WindowLeaf {
  if (currentPath) {
    const current = buffersByPath.get(currentPath)
    const leaf = current ? layout.leaves.find(candidate => candidate.bufferId === current.id) : undefined
    if (leaf) return leaf
  }
  return layout.leaves[0]!
}

function bufferForPath(editor: Editor, path: string): BufferModel | undefined {
  return [...editor.buffers.values()].find(buffer => buffer.kind === "file" && buffer.path === path)
}

function restoreWindowLayout(
  editor: Editor,
  manifest: DesktopManifest,
  buffersByPath: Map<string, BufferModel>,
): void {
  let restored = manifest.layout ? deserializeWindowLayout(manifest.layout, buffersByPath) : null
  if (!restored) {
    const buffer = manifest.currentBuffer ? buffersByPath.get(manifest.currentBuffer) : undefined
    const fallback = buffer ?? [...buffersByPath.values()][0]
    if (!fallback) return
    const leaf = createLeafWindow(fallback.id, fallback.point)
    restored = { node: leaf, leaves: [leaf] }
  }
  const selected = selectLeafForCurrent(restored, manifest.currentBuffer, buffersByPath)
  const config: Extract<RegisterContents, { kind: "window-configuration" }> = {
    kind: "window-configuration",
    layout: restored.node,
    selectedWindowId: selected.id,
    currentBufferId: selected.bufferId,
  }
  editor.restoreWindowConfiguration(config)
  // The restored layout is now this tab's layout; without this the tab still
  // holds the pre-restore configuration and switching away and back undoes it.
  editor.captureSelectedTab()
}

export async function desktopSave(editor: Editor, options: { onlyIfChanged?: boolean } = {}): Promise<void> {
  const config = editor.currentWindowConfiguration()
  const files = visitedFileBuffers(editor).flatMap(buffer => entryForBuffer(buffer) ?? [])
  // Emacs keeps `desktop-buffer-args-list` in the saved desktop, so a save that
  // runs before lazy restoration is done does not drop the pending buffers.
  const saved = new Set(files.map(file => file.path))
  for (const entry of pendingEntries.get(editor) ?? []) {
    if (!saved.has(entry.path)) files.push(entry)
  }
  const currentPath = bufferPath(editor, config.currentBufferId)
  const manifest: DesktopManifest = {
    version: 1,
    files,
    ...(currentPath ? { currentBuffer: currentPath } : {}),
    layout: serializeWindowLayout(editor, config.layout),
  }
  const text = JSON.stringify(manifest, null, 2)
  const file = desktopSaveFile()
  if (options.onlyIfChanged && lastSaved.get(editor) === `${file}\0${text}`) return
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text, "utf8")
  lastSaved.set(editor, `${file}\0${text}`)
}

function layoutPaths(node: SerializedDesktopWindow | undefined, out = new Set<string>()): Set<string> {
  if (!node) return out
  if (node.kind === "leaf") {
    if (node.path) out.add(node.path)
  } else {
    layoutPaths(node.first, out)
    layoutPaths(node.second, out)
  }
  return out
}

async function restoreEntry(editor: Editor, entry: DesktopFileEntry, select: boolean): Promise<BufferModel | null> {
  try {
    if (!await fileExists(entry.path)) return null
    const buffer = await editor.openFile(entry.path, { select })
    if (buffer.kind !== "file") return null
    buffer.point = clampPoint(buffer, entry.point)
    if (entry.mode && buffer.mode !== entry.mode) editor.enterMode(buffer, entry.mode)
    return buffer
  } catch {
    // A desktop should be best-effort: stale entries must not block startup.
    return null
  }
}

/** Split entries like Emacs `desktop-restore-eager`: the first N, plus every buffer
 *  the saved layout shows, restore now; the rest go to the lazy list. */
function partitionEntries(manifest: DesktopManifest): { eager: DesktopFileEntry[]; lazy: DesktopFileEntry[] } {
  const limit = getCustom<boolean | number>("desktop-restore-eager")
  if (limit === true || typeof limit !== "number") return { eager: manifest.files, lazy: [] }
  const visible = layoutPaths(manifest.layout)
  if (manifest.currentBuffer) visible.add(manifest.currentBuffer)
  const eager: DesktopFileEntry[] = []
  const lazy: DesktopFileEntry[] = []
  for (const [i, entry] of manifest.files.entries()) {
    if (i < limit || visible.has(entry.path)) eager.push(entry)
    else lazy.push(entry)
  }
  return { eager, lazy }
}

/** `desktop-idle-create-buffers`: restore one pending buffer per tick, without
 *  selecting it, so input and redisplay run between files. */
async function restoreLazily(editor: Editor, token: object): Promise<void> {
  const delay = getCustom<number>("desktop-lazy-idle-delay") ?? 5
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, Math.max(0, delay) * 1000)
    // Pending restoration must not keep a headless process (tests, --serve-stdio) alive.
    ;(timer as { unref?: () => void }).unref?.()
  })
  let restored = 0
  for (;;) {
    if (lazyTokens.get(editor) !== token || !editor.running) return
    const entry = pendingEntries.get(editor)?.shift()
    if (!entry) break
    if (await restoreEntry(editor, entry, false)) {
      restoredPaths.get(editor)?.add(entry.path)
      restored++
    }
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  pendingEntries.delete(editor)
  if (restored) editor.message(`Desktop: ${restored} lazily restored buffer${restored === 1 ? "" : "s"}`)
}

/** Buffers still waiting for lazy restoration. */
export function desktopPendingCount(editor: Editor): number {
  return pendingEntries.get(editor)?.length ?? 0
}

export async function desktopRead(editor: Editor): Promise<number> {
  const manifest = await readDesktopManifest()
  if (!manifest) return 0

  const token = {}
  lazyTokens.set(editor, token)
  const { eager, lazy } = partitionEntries(manifest)
  const buffersByPath = new Map<string, BufferModel>()
  // Oldest first, so each visit pushes the next more recent buffer to the front
  // and the restored recency order matches the saved one.
  for (const entry of [...eager].reverse()) {
    const buffer = await restoreEntry(editor, entry, true)
    if (buffer) buffersByPath.set(entry.path, buffer)
  }

  restoredPaths.set(editor, new Set(buffersByPath.keys()))
  if (lazy.length) {
    pendingEntries.set(editor, lazy)
    void restoreLazily(editor, token)
  } else {
    pendingEntries.delete(editor)
  }
  if (!buffersByPath.size) return 0
  restoreWindowLayout(editor, manifest, buffersByPath)
  return buffersByPath.size
}

/** Stop lazy restoration and drop its pending list. */
function cancelLazyRestore(editor: Editor): void {
  lazyTokens.delete(editor)
  pendingEntries.delete(editor)
}

export async function desktopClear(editor: Editor): Promise<number> {
  cancelLazyRestore(editor)
  let paths = restoredPaths.get(editor)
  if (!paths?.size) {
    const manifest = await readDesktopManifest()
    paths = new Set(manifest?.files.map(file => file.path) ?? [])
  }
  let killed = 0
  for (const path of paths) {
    for (;;) {
      const buffer = bufferForPath(editor, path)
      if (!buffer) break
      if (!editor.killBuffer(buffer.id)) break
      killed++
    }
  }
  restoredPaths.delete(editor)
  return killed
}

export async function desktopRevert(editor: Editor): Promise<number> {
  await desktopClear(editor)
  return desktopRead(editor)
}

export async function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): Promise<void> {
  ctx.minorMode({
    name: "desktop-save-mode",
    global: true,
    lighter: "",
    onEnable: () => setCustom("desktop-save-mode", true),
    onDisable: () => setCustom("desktop-save-mode", false),
  })
  // A reload must stop the old module's lazy loop; the new install starts its own.
  ctx.onDispose(() => cancelLazyRestore(editor))

  // Hooks are process-global; only act for the editor this install belongs to.
  ctx.hook("kill-emacs-hook", async ({ editor: ed }) => {
    if (ed === editor && editor.globalMinorModes.has("desktop-save-mode")) await desktopSave(editor)
  })

  // Like GNU desktop.el, restore from after-init-hook so enabling the mode in
  // init.ts or custom.ts (both loaded after this plugin) still takes effect.
  ctx.hook("after-init-hook", async ({ editor: ed }) => {
    if (ed !== editor || initialized.has(editor)) return
    initialized.add(editor)
    if (getCustom<boolean>("desktop-save-mode") !== true && !editor.globalMinorModes.has("desktop-save-mode")) return
    editor.enableMinorMode("desktop-save-mode")
    await desktopRead(editor)
  })

  // Saves on exit alone lose the session when the terminal is closed or the
  // process is killed, so also save periodically (GNU desktop-auto-save-timeout).
  const autoSaveSeconds = getCustom<number>("desktop-auto-save-timeout") ?? 30
  if (autoSaveSeconds > 0) {
    const timer = setInterval(() => {
      if (!initialized.has(editor) || !editor.globalMinorModes.has("desktop-save-mode")) return
      desktopSave(editor, { onlyIfChanged: true }).catch(() => { /* retry next tick */ })
    }, autoSaveSeconds * 1000)
    timer.unref?.()
    ctx.onDispose(() => clearInterval(timer))
  }

  ctx.command("desktop-save-mode", ({ editor, prefixArgument }) => {
    if (prefixArgument != null && prefixArgument <= 0) editor.disableMinorMode("desktop-save-mode")
    else if (prefixArgument != null) editor.enableMinorMode("desktop-save-mode")
    else editor.toggleMinorMode("desktop-save-mode")
    editor.message(`Desktop Save mode ${editor.globalMinorModes.has("desktop-save-mode") ? "enabled" : "disabled"}`)
  }, "Toggle saving and restoring the Jemacs desktop.")

  ctx.command("desktop-save", async ({ editor }) => {
    await desktopSave(editor)
    editor.message(`Wrote ${desktopSaveFile()}`)
  }, "Save the current Jemacs desktop.")

  ctx.command("desktop-read", async ({ editor }) => {
    const n = await desktopRead(editor)
    const pending = desktopPendingCount(editor)
    const lazy = pending ? `; ${pending} lazy` : ""
    editor.message(n ? `Restored ${n} desktop buffer${n === 1 ? "" : "s"}${lazy}` : "No desktop buffers restored")
  }, "Read and restore the saved Jemacs desktop.")

  ctx.command("desktop-clear", async ({ editor }) => {
    const n = await desktopClear(editor)
    editor.message(n ? `Closed ${n} desktop buffer${n === 1 ? "" : "s"}` : "No desktop buffers to close")
  }, "Close file buffers restored from the saved desktop.")

  ctx.command("desktop-revert", async ({ editor }) => {
    const n = await desktopRevert(editor)
    editor.message(n ? `Reverted desktop with ${n} buffer${n === 1 ? "" : "s"}` : "No desktop buffers restored")
  }, "Clear restored desktop buffers and read the saved desktop again.")

  if (getCustom<boolean>("desktop-save-mode") === true) editor.enableMinorMode("desktop-save-mode")
}
