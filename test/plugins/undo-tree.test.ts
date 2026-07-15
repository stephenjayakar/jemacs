import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, test } from "bun:test"
import { install } from "../../plugins/undo-tree"
import type { Editor } from "../../src/kernel/editor"
import { resetCustom, setCustom } from "../../src/runtime/custom"
import { makeEditor } from "./helper"
import { listWindowLeaves } from "../../src/kernel/window"

function messages(editor: Editor): string[] {
  const out: string[] = []
  editor.events.on("message", ({ text }) => { if (text) out.push(text) })
  return out
}

function branchy(editor: Editor) {
  const buffer = editor.scratch("undo.txt", "", "text")
  buffer.insert("A")
  buffer.undo()
  buffer.insert("B")
  buffer.undo()
  return buffer
}

function visualizer(editor: Editor) {
  const buf = [...editor.buffers.values()].find(b => b.name.startsWith("*undo-tree: "))
  if (!buf) throw new Error("missing undo-tree visualizer")
  return buf
}

function historyFile(dir: string, path: string): string {
  return join(dir, resolve(path).replaceAll("/", "!") + ".json")
}

describe("undo-tree plugin", () => {
  test("minor-mode keybindings shadow global undo bindings when enabled", () => {
    const editor = makeEditor()
    install(editor)
    editor.scratch("keys", "", "text")
    editor.enableMinorMode("undo-tree-mode")

    expect(editor.keymaps.lookup("C-/")).toMatchObject({ status: "matched", command: "undo-tree-undo" })
    expect(editor.keymaps.lookup("C-_")).toMatchObject({ status: "matched", command: "undo-tree-undo" })
    expect(editor.keymaps.lookup("M-_")).toMatchObject({ status: "matched", command: "undo-tree-redo" })
    expect(editor.keymaps.lookup("C-?")).toMatchObject({ status: "matched", command: "undo-tree-redo" })
    expect(editor.keymaps.lookup("C-x u")).toMatchObject({ status: "matched", command: "undo-tree-visualize" })
  })

  test("undo and redo commands move through history and report ends", async () => {
    const editor = makeEditor()
    install(editor)
    const seen = messages(editor)
    const buffer = editor.scratch("undo.txt", "", "text")
    buffer.insert("one")

    await editor.run("undo-tree-undo")
    expect(buffer.text).toBe("")
    expect(seen.at(-1)).toBe("Undo")

    await editor.run("undo-tree-undo")
    expect(seen.at(-1)).toBe("No further undo/redo information")

    await editor.run("undo-tree-redo")
    expect(buffer.text).toBe("one")
    expect(seen.at(-1)).toBe("Redo")

    await editor.run("undo-tree-redo")
    expect(seen.at(-1)).toBe("No further undo/redo information")
  })

  test("switch branch selects the older branch for redo", async () => {
    const editor = makeEditor()
    install(editor)
    const seen = messages(editor)
    const buffer = branchy(editor)
    expect(buffer.text).toBe("")

    await editor.run("undo-tree-switch-branch", ["0"])
    expect(seen.at(-1)).toBe("Using branch 0 of 2")

    await editor.run("undo-tree-redo")
    expect(buffer.text).toBe("A")
  })

  test("visualizer renders current marker and a two-branch fan", async () => {
    const editor = makeEditor()
    install(editor)
    branchy(editor)

    await editor.run("undo-tree-visualize")
    const buf = visualizer(editor)

    expect(buf.readOnly).toBe(true)
    expect(buf.mode).toBe("undo-tree-visualizer-mode")
    expect(buf.text).toContain("x")
    expect(buf.text).toContain("/")
    expect(buf.text).toContain("\\")
    expect(editor.currentBuffer.id).toBe(buf.id)
  })

  test("visualizer binds Emacs motion keys to undo-tree navigation", async () => {
    const editor = makeEditor()
    install(editor)
    const parent = editor.scratch("undo.txt", "", "text")
    parent.insert("A")

    await editor.run("undo-tree-visualize")

    expect(editor.keymaps.lookup("C-p")).toMatchObject({ status: "matched", command: "undo-tree-visualize-undo" })
    expect(editor.keymaps.lookup("C-n")).toMatchObject({ status: "matched", command: "undo-tree-visualize-redo" })
    expect(editor.keymaps.lookup("C-b")).toMatchObject({ status: "matched", command: "undo-tree-visualize-switch-branch-left" })
    expect(editor.keymaps.lookup("C-f")).toMatchObject({ status: "matched", command: "undo-tree-visualize-switch-branch-right" })

    const previous = editor.keymaps.lookup("C-p")
    if (previous.status !== "matched") throw new Error("C-p did not resolve")
    await editor.run(previous.command)
    expect(parent.text).toBe("")
    expect(parent.undoTreeSnapshot().current.id).toBe(0)
  })

  test("clicking a visualizer node sets the parent buffer to that undo node", async () => {
    const editor = makeEditor()
    install(editor)
    const parent = editor.scratch("undo.txt", "", "text")
    parent.insert("A")

    await editor.run("undo-tree-visualize")
    const buf = visualizer(editor)
    const rootPoint = buf.text.search(/[os]/)
    expect(rootPoint).toBeGreaterThanOrEqual(0)

    editor.clickWindow(editor.selectedWindowId, rootPoint)

    expect(parent.text).toBe("")
    expect(parent.undoTreeSnapshot().current.id).toBe(0)
    expect(buf.point).toBe(rootPoint)
  })

  test("visualize-undo moves the current marker up and changes parent text", async () => {
    const editor = makeEditor()
    install(editor)
    const parent = editor.scratch("undo.txt", "", "text")
    parent.insert("A")

    await editor.run("undo-tree-visualize")
    const buf = visualizer(editor)
    const before = buf.text

    await editor.run("undo-tree-visualize-undo")
    expect(parent.text).toBe("")
    expect(buf.text).not.toBe(before)
    expect(parent.undoTreeSnapshot().current.id).toBe(0)
  })

  test("visualizer branch left and right choose which child redo follows", async () => {
    const editor = makeEditor()
    install(editor)
    const parent = branchy(editor)

    await editor.run("undo-tree-visualize")
    const buf = visualizer(editor)

    await editor.run("undo-tree-visualize-switch-branch-left")
    await editor.run("undo-tree-visualize-redo")
    expect(parent.text).toBe("A")

    parent.undo()
    await editor.run("undo-tree-visualize-switch-branch-right")
    await editor.run("undo-tree-visualize-redo")
    expect(parent.text).toBe("B")
    expect(editor.currentBuffer.id).toBe(buf.id)
  })

  test("quit kills the visualizer and returns to the parent buffer", async () => {
    const editor = makeEditor()
    install(editor)
    const parent = editor.scratch("undo.txt", "base", "text")

    await editor.run("undo-tree-visualize")
    const buf = visualizer(editor)
    await editor.run("undo-tree-visualizer-quit")

    expect(editor.buffers.has(buf.id)).toBe(false)
    expect(editor.currentBuffer.id).toBe(parent.id)
    expect(listWindowLeaves(editor.windowLayout)).toHaveLength(1)
  })

  test("visualizer centers its rendered tree and binds both q spellings", async () => {
    const editor = makeEditor()
    install(editor)
    const parent = editor.scratch("undo.txt", "", "text")
    parent.insert("A")

    await editor.run("undo-tree-visualize")
    const buf = visualizer(editor)

    expect(buf.locals.get("markdown-visual-fill-column-mode")).toBe(true)
    expect(buf.locals.get("markdown-visual-fill-column-center-text")).toBe(true)
    expect(buf.locals.get("markdown-fill-column")).toBeGreaterThan(0)
    expect(editor.keymaps.lookup("q")).toMatchObject({ status: "matched", command: "undo-tree-visualizer-quit" })
    expect(editor.keymaps.lookup("S-q")).toMatchObject({ status: "matched", command: "undo-tree-visualizer-quit" })
  })

  test("abort restores the node that was current when the visualizer opened", async () => {
    const editor = makeEditor()
    install(editor)
    const parent = editor.scratch("undo.txt", "", "text")
    parent.insert("A")

    await editor.run("undo-tree-visualize")
    const openedAt = parent.undoTreeSnapshot().current.id
    await editor.run("undo-tree-visualize-undo")
    expect(parent.text).toBe("")

    await editor.run("undo-tree-visualizer-abort")
    expect(parent.undoTreeSnapshot().current.id).toBe(openedAt)
    expect(parent.text).toBe("A")
    expect(editor.currentBuffer.id).toBe(parent.id)
  })

  test("timestamps toggle renders HH:MM:SS labels", async () => {
    const editor = makeEditor()
    install(editor)
    const parent = editor.scratch("undo.txt", "", "text")
    parent.insert("A")

    await editor.run("undo-tree-visualize")
    await editor.run("undo-tree-visualizer-toggle-timestamps")

    expect(visualizer(editor).text).toMatch(/\b\d{2}:\d{2}:\d{2}\b/)
  })

  test("diff toggle opens a diff buffer with plus and minus lines", async () => {
    const editor = makeEditor()
    install(editor)
    const parent = editor.scratch("undo.txt", "", "text")
    parent.insert("old")
    parent.replaceRange(0, parent.text.length, "new")

    await editor.run("undo-tree-visualize")
    await editor.run("undo-tree-visualizer-toggle-diff")

    const diff = [...editor.buffers.values()].find(b => b.name === "*undo-tree Diff*")
    expect(diff).toBeTruthy()
    expect(diff!.mode).toBe("diff-mode")
    expect(diff!.text).toContain("-old")
    expect(diff!.text).toContain("+new")
  })

  test("global-undo-tree-mode applies to files visited after enabling", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jemacs-undo-tree-"))
    try {
      const path = join(dir, "late.txt")
      await writeFile(path, "hi", "utf8")
      const editor = makeEditor()
      install(editor)
      editor.enableMinorMode("global-undo-tree-mode")
      const buffer = await editor.openFile(path)
      expect(buffer.minorModes.has("undo-tree-mode")).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("saves and reloads undo-tree history for file buffers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jemacs-undo-tree-"))
    try {
      setCustom("undo-tree-history-directory", dir)

      const path = join(dir, "note.txt")
      await writeFile(path, "one", "utf8")
      const editor = makeEditor()
      install(editor)
      editor.enableMinorMode("global-undo-tree-mode")
      const buffer = await editor.openFile(path)
      buffer.point = 3
      buffer.insert(" two")
      const abandoned = buffer.seq
      buffer.undo()
      buffer.point = 3
      buffer.insert(" three")
      const current = buffer.seq

      await buffer.save({ runHook: (name, b) => editor.runHook(name, b) })
      await expect(access(historyFile(dir, path))).resolves.toBeNull()
      expect(JSON.parse(await readFile(historyFile(dir, path), "utf8")).currentId).toBe(current)

      const fresh = makeEditor()
      install(fresh)
      fresh.enableMinorMode("global-undo-tree-mode")
      const restored = await fresh.openFile(path)

      expect(restored.undoTreeSnapshot().current.id).toBe(current)
      expect(restored.undoToNode(abandoned)).toBe(true)
      expect(restored.text).toBe("one two")
    } finally {
      resetCustom("undo-tree-history-directory")
      await rm(dir, { recursive: true, force: true })
    }
  })
})
