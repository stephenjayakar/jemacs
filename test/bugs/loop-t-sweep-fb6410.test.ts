import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BufferModel } from "../../src/kernel/buffer"
import { script, keySeq } from "../harness"
import { makeEditor } from "../plugins/helper"
import { addHook } from "../../src/kernel/hooks"

// t-sweep-fb6410 — commands.ts still feeds raw buffer.name into user-facing
// strings (next-buffer, *-other-window collections, revert-buffer, …). With two
// same-basename files open the echo area is ambiguous and the C-x 4 b
// collection can't address the second buffer.

const settle = () => new Promise(r => setTimeout(r, 0))

function twoSameName() {
  const editor = makeEditor()
  const a = editor.addBuffer(new BufferModel({ name: "task.go", path: "/p/go-cli/task.go", text: "A" }))
  const b = editor.addBuffer(new BufferModel({ name: "task.go", path: "/p/jemacs/task.go", text: "B" }))
  return { editor, a, b }
}

test("next-buffer / previous-buffer echo the uniquified display name", async () => {
  const { editor, a, b } = twoSameName()
  editor.switchToBuffer(a.id)
  let msg = ""
  editor.events.on("message", ({ text }) => { msg = text })
  // nextBuffer cycles through *scratch*/*messages* too; step until we land on b.
  for (let i = 0; i < 8 && editor.currentBuffer.id !== b.id; i++) await editor.run("next-buffer")
  expect(editor.currentBuffer.id).toBe(b.id)
  expect(msg).toContain(editor.bufferDisplayName(b))
  expect(editor.bufferDisplayName(b)).not.toBe("task.go")
})

test("switch-to-buffer-other-window: collection lists display names and resolves them", async () => {
  const { editor, a, b } = twoSameName()
  editor.switchToBuffer(a.id)
  let offered: string[] = []
  editor.completingRead = (_p, opts) => {
    offered = (opts as { collection?: string[] }).collection ?? []
    return Promise.resolve(editor.bufferDisplayName(b))
  }
  let msg = ""
  editor.events.on("message", ({ text }) => { msg = text })
  await editor.run("switch-to-buffer-other-window")
  // Collection must be unambiguous — raw b.name would list "task.go" twice.
  expect(offered).toContain(editor.bufferDisplayName(a))
  expect(offered).toContain(editor.bufferDisplayName(b))
  expect(editor.currentBuffer.id).toBe(b.id)
  expect(msg).toContain(editor.bufferDisplayName(b))
})

test("display-buffer-other-window: initialValue and message use display name", async () => {
  const { editor, a } = twoSameName()
  editor.switchToBuffer(a.id)
  let initial: string | undefined
  editor.completingRead = (_p, opts) => {
    initial = (opts as { initialValue?: string }).initialValue
    return Promise.resolve(editor.bufferDisplayName(a))
  }
  let msg = ""
  editor.events.on("message", ({ text }) => { msg = text })
  await editor.run("display-buffer-other-window")
  expect(initial).toBe(editor.bufferDisplayName(a))
  expect(msg).toContain(editor.bufferDisplayName(a))
})

test("revert-buffer message uses the uniquified display name", async () => {
  const root = await mkdtemp(join(tmpdir(), "jemacs-fb6410-"))
  try {
    const path = join(root, "task.go")
    await writeFile(path, "disk\n")
    const editor = makeEditor()
    editor.addBuffer(new BufferModel({ name: "task.go", path: "/elsewhere/task.go", text: "" }))
    const buf = await editor.openFile(path)
    expect(editor.bufferDisplayName(buf)).not.toBe("task.go")
    let msg = ""
    editor.events.on("message", ({ text }) => { msg = text })
    await editor.run("revert-buffer", ["noconfirm"])
    expect(msg).toContain(editor.bufferDisplayName(buf))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// t-sweep-24e6f9 — save-some-buffers called b.save() bare, so before/after-save
// hooks never fired and the make-backup-files defcustom was bypassed.
test("save-some-buffers threads SaveContext: hooks fire and backups are written", async () => {
  const root = await mkdtemp(join(tmpdir(), "jemacs-fb6410-"))
  try {
    const path = join(root, "f.txt")
    await writeFile(path, "disk\n")
    const editor = makeEditor()
    const buf = await editor.openFile(path)
    buf.insert("edited ")
    const seen: string[] = []
    addHook("before-save-hook", () => { seen.push("before") })
    addHook("after-save-hook", () => { seen.push("after") })
    editor.prompt = async () => "y"
    await editor.run("save-some-buffers")
    expect(seen).toEqual(["before", "after"])
    expect(await readFile(path + "~", "utf8")).toBe("disk\n")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// t-sweep-5c6b07 — C-x C-c ran save-some-buffers then quit() unconditionally.
// Answering 'n' to a dirty buffer silently discarded the edits. Emacs gates on
// "Modified buffers exist; exit anyway?".
test("save-buffers-kill-terminal: declining the save gates quit on a second confirm", async () => {
  const editor = await script({ plugins: false }).done()
  const buf = editor.addBuffer(new BufferModel({ name: "f.txt", path: "/tmp/fb6410/f.txt", kind: "file", text: "" }))
  buf.insert("unsaved")
  editor.prompt = async () => "n" // decline save-some-buffers per-file prompt
  let asked = ""
  editor.events.on("message", ({ text }) => { if (/exit anyway/i.test(text)) asked = text })

  const done = editor.run("save-buffers-kill-terminal")
  await settle()
  expect(asked).toMatch(/exit anyway/i)
  expect(editor.running).toBe(true)
  await keySeq(editor, "n")
  await done
  expect(editor.running).toBe(true)
  expect(buf.dirty).toBe(true)
})

test("save-buffers-kill-terminal: quits without a second prompt when nothing is dirty", async () => {
  const editor = await script({ plugins: false }).done()
  let asked = false
  editor.events.on("message", ({ text }) => { if (/exit anyway/i.test(text)) asked = true })
  await editor.run("save-buffers-kill-terminal")
  expect(asked).toBe(false)
  expect(editor.running).toBe(false)
})
