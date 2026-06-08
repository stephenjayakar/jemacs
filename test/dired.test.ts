import { expect, test } from "bun:test"
import { mkdir, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { installDefaultConfig as installDefaultCommands } from "../src/config"
import { Editor } from "../src/kernel/editor"
import {
  diredDoCopy,
  diredDoDelete,
  diredDoFlaggedDelete,
  diredEntryAtPoint,
  diredFlagFileDeletion,
  diredFlaggedEntries,
  diredMarkAll,
  diredMarkEntry,
  diredMarkedFilesSummary,
  diredMarkFilesRegexp,
  diredToggleMarks,
  diredToggleMark,
  diredUnmarkAll,
  diredUnmarkAllFiles,
  diredUnmarkEntry,
  refreshDiredBuffer,
} from "../src/modes/dired"
import { installDefaultModes } from "../src/modes/default-modes"

async function tempDiredDir(): Promise<string> {
  const dir = `/tmp/jemacs-dired-${Date.now()}-${Math.random().toString(36).slice(2)}`
  await mkdir(dir, { recursive: true })
  await Bun.write(join(dir, "alpha.txt"), "alpha")
  await Bun.write(join(dir, "beta.txt"), "beta")
  return dir
}

test("dired mark, unmark, toggle, and mark-all update the listing", async () => {
  installDefaultModes()
  const editor = new Editor()
  installDefaultCommands(editor)
  const dir = await tempDiredDir()
  try {
    const buffer = await editor.openDirectory(dir)
    const alphaLine = buffer.text.indexOf("alpha.txt")
    buffer.point = alphaLine

    diredMarkEntry(buffer, diredEntryAtPoint(buffer), "marked")
    expect(buffer.text).toContain("* -")

    diredToggleMark(buffer, diredEntryAtPoint(buffer))
    expect(buffer.text).not.toContain("* -     ")

    diredMarkAll(buffer)
    expect(buffer.text.match(/^\* /gm)?.length).toBeGreaterThanOrEqual(2)

    diredToggleMarks(buffer)
    expect(buffer.text).not.toMatch(/^\* /m)

    diredToggleMarks(buffer)
    expect(buffer.text.match(/^\* /gm)?.length).toBeGreaterThanOrEqual(2)

    diredUnmarkAll(buffer)
    expect(buffer.text).not.toMatch(/^\* /m)

    buffer.point = buffer.text.indexOf("alpha.txt")
    diredMarkEntry(buffer, diredEntryAtPoint(buffer), "marked")
    buffer.point = buffer.text.indexOf("beta.txt")
    diredFlagFileDeletion(buffer, diredEntryAtPoint(buffer))
    expect(buffer.text).toMatch(/^\* -.*alpha\.txt/m)
    expect(buffer.text).toMatch(/^D -.*beta\.txt/m)

    expect(await diredUnmarkAllFiles(buffer, "*")).toBe(1)
    expect(buffer.text).not.toMatch(/^\* -.*alpha\.txt/m)
    expect(buffer.text).toMatch(/^D -.*beta\.txt/m)

    expect(await diredUnmarkAllFiles(buffer)).toBe(1)
    expect(buffer.text).not.toMatch(/^D -.*beta\.txt/m)

    const count = diredMarkFilesRegexp(buffer, "beta\\.txt$", "marked")
    expect(count).toBe(1)
    expect(buffer.text).toContain("beta.txt")
    expect(buffer.text).toMatch(/^\* -.*beta\.txt/m)
    expect(diredMarkedFilesSummary(buffer)).toEqual({ count: 1, totalSize: 4 })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("dired opens with point on the first real file", async () => {
  installDefaultModes()
  const editor = new Editor()
  installDefaultCommands(editor)
  const dir = await tempDiredDir()
  try {
    const buffer = await editor.openDirectory(dir)
    expect(diredEntryAtPoint(buffer)?.name).toBe("alpha.txt")
    expect(buffer.point).toBe(buffer.text.indexOf("alpha.txt"))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("dired copies and deletes files with Emacs-style prompts", async () => {
  installDefaultModes()
  const editor = new Editor()
  installDefaultCommands(editor)
  const dir = await tempDiredDir()
  const dest = `${dir}-copy`
  try {
    const buffer = await editor.openDirectory(dir)
    buffer.point = buffer.text.indexOf("alpha.txt")
    diredMarkEntry(buffer, diredEntryAtPoint(buffer), "marked")

    const copyPrompt = diredDoCopy(editor, buffer, null)
    expect(editor.minibuffer?.prompt).toContain("Copy to:")
    editor.activeBuffer.setText(dest, true)
    editor.activeBuffer.point = dest.length
    await editor.handleKey({ name: "return" })
    await copyPrompt
    expect(await readFile(join(dest, "alpha.txt"), "utf8")).toBe("alpha")

    buffer.point = buffer.text.indexOf("beta.txt")
    diredMarkEntry(buffer, diredEntryAtPoint(buffer), "delete")
    expect(diredFlaggedEntries(buffer).map(entry => entry.name)).toEqual(["beta.txt"])

    const deletePrompt = diredDoFlaggedDelete(editor, buffer)
    editor.activeBuffer.setText("yes", true)
    await editor.handleKey({ name: "return" })
    await deletePrompt
    await expect(stat(join(dir, "beta.txt"))).rejects.toThrow()

    buffer.point = buffer.text.indexOf("alpha.txt")
    const rmPrompt = diredDoDelete(editor, buffer, null)
    editor.activeBuffer.setText("yes", true)
    await editor.handleKey({ name: "return" })
    await rmPrompt
    await expect(stat(join(dir, "alpha.txt"))).rejects.toThrow()
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(dest, { recursive: true, force: true })
  }
})

test("dired keymap binds mark, copy, delete, and regexp commands", async () => {
  installDefaultModes()
  const { getMode } = await import("../src/modes/mode")
  installDefaultModes()
  const keymap = getMode("dired")?.keymap
  const editor = new Editor()
  installDefaultCommands(editor)
  expect(editor.commands.get("dired-unmark-all-files")?.description).toContain("specific mark")
  expect(editor.commands.get("dired-number-of-marked-files")?.description).toContain("total size")
  expect(keymap?.get("m")).toBe("dired-mark")
  expect(keymap?.get("S-c")).toBe("dired-do-copy")
  expect(keymap?.get("d")).toBe("dired-flag-file-deletion")
  expect(keymap?.get("S-d")).toBe("dired-do-delete")
  expect(keymap?.get("u")).toBe("dired-unmark")
  expect(keymap?.get("S-u")).toBe("dired-unmark-all-marks")
  expect(keymap?.get("t")).toBe("dired-toggle-marks")
  expect(keymap?.get("g")).toBe("revert-buffer")
  expect(keymap?.get("x")).toBe("dired-do-flagged-delete")
  expect(keymap?.get("% m")).toBe("dired-mark-files-regexp")
  expect(keymap?.get("* %")).toBe("dired-mark-files-regexp")
  expect(keymap?.get("% .")).toBeUndefined()
  expect(keymap?.get("+")).toBe("dired-create-directory")
})

test("dired-number-of-marked-files reports count and total size", async () => {
  installDefaultModes()
  const editor = new Editor()
  installDefaultCommands(editor)
  const dir = await tempDiredDir()
  try {
    const buffer = await editor.openDirectory(dir)
    buffer.point = buffer.text.indexOf("alpha.txt")
    diredMarkEntry(buffer, diredEntryAtPoint(buffer), "marked")
    buffer.point = buffer.text.indexOf("beta.txt")
    diredMarkEntry(buffer, diredEntryAtPoint(buffer), "delete")
    let message = ""
    editor.events.on("message", ({ text }) => { message = text })

    await editor.run("dired-number-of-marked-files")

    expect(message).toBe("1 marked file, 5 bytes total")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("dired-unmark-all-files command removes a selected mark and can query each file", async () => {
  installDefaultModes()
  const editor = new Editor()
  installDefaultCommands(editor)
  const dir = await tempDiredDir()
  try {
    const buffer = await editor.openDirectory(dir)
    buffer.point = buffer.text.indexOf("alpha.txt")
    diredMarkEntry(buffer, diredEntryAtPoint(buffer), "marked")
    buffer.point = buffer.text.indexOf("beta.txt")
    diredFlagFileDeletion(buffer, diredEntryAtPoint(buffer))

    await editor.run("dired-unmark-all-files", ["D"])
    expect(buffer.text).toMatch(/^\* -.*alpha\.txt/m)
    expect(buffer.text).not.toMatch(/^D -.*beta\.txt/m)

    buffer.point = buffer.text.indexOf("beta.txt")
    diredFlagFileDeletion(buffer, diredEntryAtPoint(buffer))
    editor.prefixArg.universalArgument()
    const pending = editor.run("dired-unmark-all-files", [""])
    await editor.handleKey({ name: "n", sequence: "n" })
    await new Promise(resolve => setTimeout(resolve, 0))
    await editor.handleKey({ name: "y", sequence: "y" })
    await pending
    expect(buffer.text).toMatch(/^\* -.*alpha\.txt/m)
    expect(buffer.text).not.toMatch(/^D -.*beta\.txt/m)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("make-directory and dired + create a subdirectory", async () => {
  installDefaultModes()
  const editor = new Editor()
  installDefaultCommands(editor)
  const dir = await tempDiredDir()
  try {
    expect(editor.commands.get("make-directory")).toBeDefined()
    const buffer = await editor.openDirectory(dir)
    await editor.run("make-directory", ["nested"])
    expect((await stat(join(dir, "nested"))).isDirectory()).toBe(true)
    expect(buffer.text).toContain("nested")

    await editor.run("dired-create-directory", ["nested-2"])
    expect((await stat(join(dir, "nested-2"))).isDirectory()).toBe(true)
    expect(buffer.text).toContain("nested-2")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("dired revert keeps marks on surviving files", async () => {
  installDefaultModes()
  const editor = new Editor()
  const dir = await tempDiredDir()
  try {
    const buffer = await editor.openDirectory(dir)
    buffer.point = buffer.text.indexOf("alpha.txt")
    diredMarkEntry(buffer, diredEntryAtPoint(buffer), "marked")
    await Bun.write(join(dir, "gamma.txt"), "gamma")
    await refreshDiredBuffer(buffer)
    expect(buffer.text).toMatch(/^\* -.*alpha\.txt/m)
    expect(buffer.text).toContain("gamma.txt")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
