import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { install, desktopClear, desktopPendingCount, desktopRead, desktopSave, type DesktopManifest } from "../../plugins/desktop"
import { listWindowLeaves } from "../../src/kernel/window"
import { resetCustom, setCustom } from "../../src/runtime/custom"
import { makeEditor } from "./helper"

let dir: string

beforeEach(async () => {
  resetCustom("desktop-save-mode")
  resetCustom("desktop-save-file")
  resetCustom("desktop-restore-eager")
  resetCustom("desktop-lazy-idle-delay")
  dir = await mkdtemp(join(tmpdir(), "jemacs-desktop-"))
})

afterEach(async () => {
  resetCustom("desktop-save-mode")
  resetCustom("desktop-save-file")
  await rm(dir, { recursive: true, force: true })
})

async function writeText(name: string, text: string): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, text, "utf8")
  return path
}

function fileBufferPaths(editor: ReturnType<typeof makeEditor>): string[] {
  return [...editor.buffers.values()]
    .filter(buffer => buffer.kind === "file" && buffer.path)
    .map(buffer => buffer.path!)
}

test("desktop-save writes file buffers, points, current buffer, and window layout", async () => {
  const editor = makeEditor()
  await install(editor)
  const desktopFile = join(dir, "desktop.json")
  setCustom("desktop-save-file", desktopFile)

  const firstPath = await writeText("first.txt", "abcdef\n")
  const secondPath = await writeText("second.txt", "0123456789\n")
  const first = await editor.openFile(firstPath)
  first.point = 3
  editor.enterMode(first, "python")

  editor.splitWindowRight()
  editor.selectWindow(listWindowLeaves(editor.windowLayout)[1]!.id)
  const second = await editor.openFile(secondPath)
  second.point = 5

  await editor.run("desktop-save-mode")
  await editor.runHook("kill-emacs-hook", editor.currentBuffer)

  const raw = JSON.parse(await readFile(desktopFile, "utf8")) as DesktopManifest
  expect(raw.version).toBe(1)
  expect(raw.currentBuffer).toBe(secondPath)
  expect(raw.files).toContainEqual({ path: firstPath, point: 3, mode: "python" })
  expect(raw.files).toContainEqual({ path: secondPath, point: 5 })
  expect(raw.layout?.kind).toBe("split")
  if (raw.layout?.kind !== "split") return
  expect(raw.layout.direction).toBe("horizontal")
  expect(raw.layout.first.kind).toBe("leaf")
  expect(raw.layout.second.kind).toBe("leaf")
  if (raw.layout.first.kind === "leaf") expect(raw.layout.first.path).toBe(firstPath)
  if (raw.layout.second.kind === "leaf") expect(raw.layout.second.path).toBe(secondPath)
})

test("desktop-read restores buffers, points, modes, and split layout", async () => {
  const desktopFile = join(dir, "desktop.json")
  const firstPath = await writeText("first.txt", "abcdef\n")
  const secondPath = await writeText("second.txt", "0123456789\n")

  const source = makeEditor()
  await install(source)
  setCustom("desktop-save-file", desktopFile)
  const first = await source.openFile(firstPath)
  first.point = 2
  source.enterMode(first, "python")
  source.splitWindowRight()
  source.selectWindow(listWindowLeaves(source.windowLayout)[1]!.id)
  const second = await source.openFile(secondPath)
  second.point = 6
  await source.run("desktop-save")

  const restored = makeEditor()
  await install(restored)
  setCustom("desktop-save-file", desktopFile)
  const count = await desktopRead(restored)

  expect(count).toBe(2)
  const restoredFirst = [...restored.buffers.values()].find(buffer => buffer.path === firstPath)
  const restoredSecond = [...restored.buffers.values()].find(buffer => buffer.path === secondPath)
  expect(restoredFirst?.point).toBe(2)
  expect(restoredFirst?.mode).toBe("python")
  expect(restoredSecond?.point).toBe(6)
  expect(restored.currentBuffer.path).toBe(secondPath)
  expect(listWindowLeaves(restored.windowLayout)).toHaveLength(2)
  expect(restored.windowLayout.kind).toBe("split")
})

test("desktop-read skips missing files without error", async () => {
  const desktopFile = join(dir, "desktop.json")
  const existingPath = await writeText("exists.txt", "hello\n")
  const missingPath = join(dir, "missing.txt")
  const manifest: DesktopManifest = {
    version: 1,
    files: [
      { path: missingPath, point: 7 },
      { path: existingPath, point: 4 },
    ],
    currentBuffer: missingPath,
    layout: {
      kind: "split",
      direction: "horizontal",
      first: { kind: "leaf", path: missingPath, point: 7 },
      second: { kind: "leaf", path: existingPath, point: 4 },
    },
  }
  await writeFile(desktopFile, JSON.stringify(manifest, null, 2), "utf8")

  const editor = makeEditor()
  await install(editor)
  setCustom("desktop-save-file", desktopFile)
  const count = await desktopRead(editor)

  expect(count).toBe(1)
  expect(fileBufferPaths(editor)).toEqual([existingPath])
  expect(editor.currentBuffer.path).toBe(existingPath)
  expect(editor.currentBuffer.point).toBe(4)
  expect(listWindowLeaves(editor.windowLayout)).toHaveLength(1)
})

test("after-init-hook auto-restores only when desktop-save-mode custom is enabled", async () => {
  const desktopFile = join(dir, "desktop.json")
  const path = await writeText("auto.txt", "auto restore\n")
  await writeFile(desktopFile, JSON.stringify({
    version: 1,
    files: [{ path, point: 5 }],
    currentBuffer: path,
  } satisfies DesktopManifest, null, 2), "utf8")

  setCustom("desktop-save-file", desktopFile)
  setCustom("desktop-save-mode", false)
  const disabled = makeEditor()
  await install(disabled)
  await disabled.runHook("after-init-hook", disabled.currentBuffer)
  expect(fileBufferPaths(disabled)).toEqual([])

  setCustom("desktop-save-file", desktopFile)
  setCustom("desktop-save-mode", true)
  const enabled = makeEditor()
  await install(enabled)
  expect(fileBufferPaths(enabled)).toEqual([])
  await enabled.runHook("after-init-hook", enabled.currentBuffer)
  expect(fileBufferPaths(enabled)).toEqual([path])
  expect(enabled.currentBuffer.point).toBe(5)
  expect(enabled.globalMinorModes.has("desktop-save-mode")).toBe(true)
})

async function lazyDesktop(): Promise<{ paths: string[]; shown: string }> {
  const paths = await Promise.all([0, 1, 2, 3].map(i => writeText(`f${i}.txt`, `file ${i}\n`)))
  const shown = paths[3]!
  const desktopFile = join(dir, "desktop.json")
  await writeFile(desktopFile, JSON.stringify({
    version: 1,
    files: paths.map(path => ({ path, point: 2 })),
    currentBuffer: shown,
    layout: { kind: "leaf", path: shown, point: 2 },
  } satisfies DesktopManifest), "utf8")
  setCustom("desktop-save-file", desktopFile)
  setCustom("desktop-restore-eager", 1)
  setCustom("desktop-lazy-idle-delay", 0)
  return { paths, shown }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5))
}

test("desktop-restore-eager restores N plus layout buffers now, the rest lazily", async () => {
  const { paths, shown } = await lazyDesktop()
  const editor = makeEditor()

  expect(await desktopRead(editor)).toBe(2)
  // Emacs: the first N, plus every buffer a saved window shows, restore eagerly.
  expect(fileBufferPaths(editor).sort()).toEqual([paths[0]!, shown].sort())
  expect(desktopPendingCount(editor)).toBe(2)

  await waitFor(() => desktopPendingCount(editor) === 0)
  expect(fileBufferPaths(editor).sort()).toEqual([...paths].sort())
  // Lazy buffers are `find-file-noselect`ed: the restored layout keeps its buffer.
  expect(editor.currentBuffer.path).toBe(shown)
  expect(listWindowLeaves(editor.windowLayout).map(leaf => editor.buffers.get(leaf.bufferId)?.path)).toEqual([shown])
  const lazyBuffer = [...editor.buffers.values()].find(buffer => buffer.path === paths[1])!
  expect(lazyBuffer.point).toBe(2)
})

test("desktop-save keeps entries that are still pending lazy restoration", async () => {
  const { paths } = await lazyDesktop()
  setCustom("desktop-lazy-idle-delay", 60)
  const editor = makeEditor()
  await desktopRead(editor)
  expect(desktopPendingCount(editor)).toBe(2)

  await desktopSave(editor)
  const saved = JSON.parse(await readFile(join(dir, "desktop.json"), "utf8")) as DesktopManifest
  expect(saved.files.map(file => file.path).sort()).toEqual([...paths].sort())
  await desktopClear(editor)
})

test("desktop-clear cancels pending lazy restoration", async () => {
  await lazyDesktop()
  const editor = makeEditor()
  await desktopRead(editor)
  await desktopClear(editor)
  expect(desktopPendingCount(editor)).toBe(0)
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(fileBufferPaths(editor)).toEqual([])
})

test("desktop-save lists file buffers most recently used first", async () => {
  const editor = makeEditor()
  setCustom("desktop-save-file", join(dir, "desktop.json"))
  const older = await writeText("older.txt", "a\n")
  const newer = await writeText("newer.txt", "b\n")
  await editor.openFile(older)
  await editor.openFile(newer)
  await desktopSave(editor)
  const saved = JSON.parse(await readFile(join(dir, "desktop.json"), "utf8")) as DesktopManifest
  expect(saved.files.map(file => file.path)).toEqual([newer, older])
})

test("enabling desktop-save-mode after install, as init.ts does, restores at after-init", async () => {
  const desktopFile = join(dir, "desktop.json")
  const path = await writeText("late.txt", "late enable\n")
  await writeFile(desktopFile, JSON.stringify({
    version: 1,
    files: [{ path, point: 3 }],
    currentBuffer: path,
  } satisfies DesktopManifest, null, 2), "utf8")
  setCustom("desktop-save-file", desktopFile)

  const editor = makeEditor()
  await install(editor)
  editor.enableMinorMode("desktop-save-mode")
  await editor.runHook("after-init-hook", editor.currentBuffer)
  // A second run (e.g. another editor's boot in the same process) must not re-read.
  await editor.runHook("after-init-hook", editor.currentBuffer)

  expect(fileBufferPaths(editor)).toEqual([path])
  expect(editor.currentBuffer.point).toBe(3)
})
