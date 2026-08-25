import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { install, desktopRead, type DesktopManifest } from "../../plugins/desktop"
import { listWindowLeaves } from "../../src/kernel/window"
import { resetCustom, setCustom } from "../../src/runtime/custom"
import { makeEditor } from "./helper"

let dir: string

beforeEach(async () => {
  resetCustom("desktop-save-mode")
  resetCustom("desktop-save-file")
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

test("install auto-restores only when desktop-save-mode custom is enabled", async () => {
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
  expect(fileBufferPaths(disabled)).toEqual([])

  setCustom("desktop-save-file", desktopFile)
  setCustom("desktop-save-mode", true)
  const enabled = makeEditor()
  await install(enabled)
  expect(fileBufferPaths(enabled)).toEqual([path])
  expect(enabled.currentBuffer.point).toBe(5)
  expect(enabled.globalMinorModes.has("desktop-save-mode")).toBe(true)
})
