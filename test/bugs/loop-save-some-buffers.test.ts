import { test, expect } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { script, keySeq } from "../harness"
import { BufferModel } from "../../src/kernel/buffer"

const settle = () => new Promise(r => setTimeout(r, 0))

test("save-buffers-kill-terminal prompts for dirty file buffers before quitting", async () => {
  const ed = await script().done()
  ed.currentBuffer.path = "/tmp/jemacs-dirty.txt"
  ed.currentBuffer.kind = "file"
  ed.currentBuffer.setText("changed")
  let prompted = ""
  ed.events.on("message", ({ text }) => { if (text.includes("Save file")) prompted = text })
  const done = ed.run("save-buffers-kill-terminal")
  await settle()
  expect(prompted).toContain("Save file")
  expect(ed.running).toBe(true)
  await keySeq(ed, "q")
  await settle()
  await keySeq(ed, "n")
  await done
})

test("C-x s is bound to save-some-buffers", async () => {
  const ed = await script().done()
  expect(ed.commands.get("save-some-buffers")).toBeDefined()
  expect(ed.describeKey("C-x s")).toContain("save-some-buffers")
})

test("save-some-buffers saves on single y without Enter", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-save-some-key-"))
  try {
    const path = join(dir, "a.txt")
    await writeFile(path, "old")
    const ed = await script({ plugins: false }).done()
    const buf = await ed.openFile(path)
    buf.setText("new", true)

    const done = ed.run("save-some-buffers")
    await settle()
    await keySeq(ed, "y")
    await done

    expect(await readFile(path, "utf8")).toBe("new")
    expect(buf.dirty).toBe(false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("save-some-buffers q stops before prompting remaining buffers", async () => {
  const ed = await script({ plugins: false }).done()
  const a = ed.addBuffer(new BufferModel({ name: "a.txt", path: "/tmp/jemacs-save-some-q/a.txt", kind: "file", text: "a" }))
  const b = ed.addBuffer(new BufferModel({ name: "b.txt", path: "/tmp/jemacs-save-some-q/b.txt", kind: "file", text: "b" }))
  a.dirty = true
  b.dirty = true
  let prompts = 0
  ed.events.on("message", ({ text }) => { if (text.includes("Save file")) prompts++ })

  const done = ed.run("save-some-buffers")
  await settle()
  await keySeq(ed, "q")
  await done

  expect(prompts).toBe(1)
  expect(a.dirty).toBe(true)
  expect(b.dirty).toBe(true)
})
