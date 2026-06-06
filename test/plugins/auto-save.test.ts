import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeEditor } from "./helper"
import { install } from "../../plugins/auto-save"
import { setCustom } from "../../src/runtime/custom"
import { clearHooks } from "../../src/kernel/hooks"
import { clearAdvice } from "../../src/runtime/advice"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { fileExists, readFileText } from "../../src/platform/runtime"
import type { Editor } from "../../src/kernel/editor"

let dir: string
let editor: Editor
let ctx: PluginContext | undefined

beforeEach(async () => {
  clearHooks()
  clearAdvice()
  dir = await mkdtemp(join(tmpdir(), "jemacs-autosave-"))
  editor = makeEditor()
  ctx = undefined
})

afterEach(async () => {
  ctx?.dispose()
  editor.stopAutoSave()
  clearHooks()
  clearAdvice()
  await rm(dir, { recursive: true, force: true })
})

describe("buffer-name uniquify", () => {
  test("colliding basenames get <parent> suffixes; switchToBuffer accepts them", async () => {
    await mkdir(join(dir, "cmd"), { recursive: true })
    await mkdir(join(dir, "task"), { recursive: true })
    await writeFile(join(dir, "cmd", "task.go"), "package cmd\n")
    await writeFile(join(dir, "task", "task.go"), "package task\n")

    const a = await editor.openFile(join(dir, "cmd", "task.go"))
    expect(editor.bufferDisplayName(a)).toBe("task.go")

    const b = await editor.openFile(join(dir, "task", "task.go"))
    expect(editor.bufferDisplayName(a)).toBe("task.go<cmd>")
    expect(editor.bufferDisplayName(b)).toBe("task.go<task>")
    expect(a.name).toBe("task.go")

    editor.switchToBuffer("task.go<cmd>")
    expect(editor.currentBuffer.id).toBe(a.id)

    editor.killBuffer(b.id)
    expect(editor.bufferDisplayName(a)).toBe("task.go")
  })

  test("deeper collision walks more parent segments", async () => {
    await mkdir(join(dir, "x", "pkg"), { recursive: true })
    await mkdir(join(dir, "y", "pkg"), { recursive: true })
    await writeFile(join(dir, "x", "pkg", "main.go"), "x")
    await writeFile(join(dir, "y", "pkg", "main.go"), "y")

    const a = await editor.openFile(join(dir, "x", "pkg", "main.go"))
    const b = await editor.openFile(join(dir, "y", "pkg", "main.go"))
    expect(editor.bufferDisplayName(a)).toBe("main.go<x/pkg>")
    expect(editor.bufferDisplayName(b)).toBe("main.go<y/pkg>")
  })

  test("non-colliding and special buffers keep their names", () => {
    const scratch = [...editor.buffers.values()].find(b => b.name === "*scratch*")!
    expect(editor.bufferDisplayName(scratch)).toBe("*scratch*")
  })
})

describe("auto-save", () => {
  test("doAutoSave writes #basename# for dirty file buffers only", async () => {
    const path = join(dir, "note.txt")
    await writeFile(path, "disk\n")
    const buf = await editor.openFile(path)
    expect(editor.autoSavePath(buf)).toBe(join(dir, "#note.txt#"))

    expect(await editor.doAutoSave()).toBe(0)
    expect(await fileExists(join(dir, "#note.txt#"))).toBe(false)

    buf.insert("edited ")
    expect(buf.dirty).toBe(true)
    expect(await editor.doAutoSave()).toBe(1)
    expect(await readFileText(join(dir, "#note.txt#"))).toBe("edited disk\n")
  })

  test("keystroke threshold triggers auto-save via handleKey", async () => {
    setCustom("auto-save-keystroke-interval", 3)
    install(editor, ctx = createPluginContext(editor))
    const path = join(dir, "k.txt")
    await writeFile(path, "")
    await editor.openFile(path)

    await editor.handleKey({ name: "a", sequence: "a" })
    await editor.handleKey({ name: "b", sequence: "b" })
    expect(await fileExists(join(dir, "#k.txt#"))).toBe(false)
    await editor.handleKey({ name: "c", sequence: "c" })
    await new Promise(r => setTimeout(r, 10))
    expect(await readFileText(join(dir, "#k.txt#"))).toBe("abc")
  })

  test("after-save-hook deletes #file# on successful save", async () => {
    install(editor, ctx = createPluginContext(editor))
    // Reinstall save-hooks advice since clearHooks/clearAdvice ran after makeEditor.
    const { install: installSaveHooks } = await import("../../plugins/save-hooks")
    installSaveHooks(editor)

    const path = join(dir, "s.txt")
    await writeFile(path, "old\n")
    const buf = await editor.openFile(path)
    buf.insert("new ")
    await editor.doAutoSave()
    expect(await fileExists(join(dir, "#s.txt#"))).toBe(true)

    await editor.run("save-buffer")
    expect(buf.dirty).toBe(false)
    expect(await fileExists(join(dir, "#s.txt#"))).toBe(false)
  })

  test("recoverThisFile restores from newer #file#", async () => {
    const path = join(dir, "r.txt")
    await writeFile(path, "stale\n")
    const past = Date.now() / 1000 - 60
    await utimes(path, past, past)
    const buf = await editor.openFile(path)

    await writeFile(join(dir, "#r.txt#"), "recovered\n")

    const recovery = editor.recoverThisFile(buf)
    await new Promise(r => setTimeout(r, 0))
    while (!editor.minibuffer) await new Promise(r => setTimeout(r, 1))
    editor.minibufferAccept("y")
    expect(await recovery).toBe(true)
    expect(buf.text).toBe("recovered\n")
    expect(buf.dirty).toBe(true)
  })

  test("recoverThisFile refuses when auto-save is not newer", async () => {
    const path = join(dir, "r2.txt")
    await writeFile(join(dir, "#r2.txt#"), "old autosave\n")
    const past = Date.now() / 1000 - 60
    await utimes(join(dir, "#r2.txt#"), past, past)
    await writeFile(path, "fresh\n")
    const buf = await editor.openFile(path)

    expect(await editor.recoverThisFile(buf)).toBe(false)
    expect(buf.text).toBe("fresh\n")
  })

  test("recoverThisFile reports missing auto-save", async () => {
    const path = join(dir, "none.txt")
    await writeFile(path, "x\n")
    const buf = await editor.openFile(path)
    expect(await editor.recoverThisFile(buf)).toBe(false)
  })

  test("startAutoSave timer fires doAutoSave", async () => {
    setCustom("auto-save-interval", 0.02)
    install(editor, ctx = createPluginContext(editor))
    const path = join(dir, "t.txt")
    await writeFile(path, "")
    const buf = await editor.openFile(path)
    buf.insert("hi")
    const ok = await waitFor(() => fileExists(join(dir, "#t.txt#")), 500)
    expect(ok).toBe(true)
  })

  test("autoSavePath is null for non-file buffers", () => {
    const scratch = [...editor.buffers.values()].find(b => b.name === "*scratch*")!
    expect(editor.autoSavePath(scratch)).toBeNull()
  })
})

async function waitFor(pred: () => Promise<boolean> | boolean, timeout = 1000): Promise<boolean> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await pred()) return true
    await new Promise(r => setTimeout(r, 5))
  }
  return await pred()
}
