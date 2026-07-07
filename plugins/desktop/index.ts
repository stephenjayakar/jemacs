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
  "When non-nil, restore the saved Jemacs desktop at startup and save it on exit.")
defcustom("desktop-save-file", "string", join(homedir(), ".jemacs", "desktop.json"),
  "File where desktop-save-mode persists the session.")

const restoredPaths = new WeakMap<Editor, Set<string>>()

export function desktopSaveFile(): string {
  return getCustom<string>("desktop-save-file") ?? join(homedir(), ".jemacs", "desktop.json")
}

function visitedFileBuffers(editor: Editor): BufferModel[] {
  return [...editor.buffers.values()].filter(buffer => buffer.kind === "file" && !!buffer.path)
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
  if (editor.tabs[editor.selectedTab]) editor.tabs[editor.selectedTab]!.bufferId = selected.bufferId
}

export async function desktopSave(editor: Editor): Promise<void> {
  const config = editor.currentWindowConfiguration()
  const files = visitedFileBuffers(editor).flatMap(buffer => entryForBuffer(buffer) ?? [])
  const currentPath = bufferPath(editor, config.currentBufferId)
  const manifest: DesktopManifest = {
    version: 1,
    files,
    ...(currentPath ? { currentBuffer: currentPath } : {}),
    layout: serializeWindowLayout(editor, config.layout),
  }
  const file = desktopSaveFile()
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(manifest, null, 2), "utf8")
}

export async function desktopRead(editor: Editor): Promise<number> {
  const manifest = await readDesktopManifest()
  if (!manifest) return 0

  const buffersByPath = new Map<string, BufferModel>()
  for (const entry of manifest.files) {
    try {
      if (!await fileExists(entry.path)) continue
      const buffer = await editor.openFile(entry.path)
      if (buffer.kind !== "file") continue
      buffer.point = clampPoint(buffer, entry.point)
      if (entry.mode && buffer.mode !== entry.mode) editor.enterMode(buffer, entry.mode)
      buffersByPath.set(entry.path, buffer)
    } catch {
      // A desktop should be best-effort: stale entries must not block startup.
    }
  }

  if (!buffersByPath.size) return 0
  restoreWindowLayout(editor, manifest, buffersByPath)
  restoredPaths.set(editor, new Set(buffersByPath.keys()))
  return buffersByPath.size
}

export async function desktopClear(editor: Editor): Promise<number> {
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

  ctx.hook("kill-emacs-hook", async ({ editor }) => {
    if (editor.globalMinorModes.has("desktop-save-mode")) await desktopSave(editor)
  })

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
    editor.message(n ? `Restored ${n} desktop buffer${n === 1 ? "" : "s"}` : "No desktop buffers restored")
  }, "Read and restore the saved Jemacs desktop.")

  ctx.command("desktop-clear", async ({ editor }) => {
    const n = await desktopClear(editor)
    editor.message(n ? `Closed ${n} desktop buffer${n === 1 ? "" : "s"}` : "No desktop buffers to close")
  }, "Close file buffers restored from the saved desktop.")

  ctx.command("desktop-revert", async ({ editor }) => {
    const n = await desktopRevert(editor)
    editor.message(n ? `Reverted desktop with ${n} buffer${n === 1 ? "" : "s"}` : "No desktop buffers restored")
  }, "Clear restored desktop buffers and read the saved desktop again.")

  if (getCustom<boolean>("desktop-save-mode") === true) {
    editor.enableMinorMode("desktop-save-mode")
    await desktopRead(editor)
  }
}
