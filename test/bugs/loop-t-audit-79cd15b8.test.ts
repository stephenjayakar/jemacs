import { expect, test } from "bun:test"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { script } from "../harness"

// t-audit-79cd15b8 — find-alternate-file: readFileText is not wrapped, so any
// FS error (EISDIR, EACCES, ENOTDIR) propagates to the top-level instead of
// landing in the echo area like save-buffer/write-file do.
test("find-alternate-file: read error is messaged, not thrown; buffer left intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-altfile-"))
  try {
    let lastMessage = ""
    const ed = await script()
      .do(e => { e.events.on("message", ({ text }) => { lastMessage = text }) })
      .do((_e, b) => { b.path = join(dir, "orig.txt"); b.kind = "file"; b.setText("original", false); b.dirty = false })
      .done()
    const before = ed.currentBuffer.text

    // readFile on a directory → EISDIR, which readFileText re-throws.
    await expect(ed.run("find-alternate-file", [dir])).resolves.toBeUndefined()
    expect(lastMessage).toContain("EISDIR")
    expect(ed.currentBuffer.text).toBe(before)
    expect(ed.currentBuffer.path).toBe(join(dir, "orig.txt"))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// t-audit-d3c507ca — save-some-buffers: per-buffer b.save() is unguarded, so
// the first failure aborts the loop and later dirty buffers never get offered.
test("save-some-buffers: one failing save does not abort the loop; summary reports failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-savesome-"))
  try {
    let lastMessage = ""
    const ed = await script()
      .do(e => { e.events.on("message", ({ text }) => { lastMessage = text }) })
      .done()
    const mk = (path: string) => {
      const b = ed.scratch(path.split("/").pop()!, "x")
      b.path = path; b.kind = "file"; b.dirty = true
      return b
    }
    mk(join(dir, "a.txt"))
    mk(join(dir, "missing", "b.txt")) // parent dir absent → writeFile ENOENT
    mk(join(dir, "c.txt"))

    ed.events.on("minibuffer", () => ed.minibufferAccept("!"))
    await expect(ed.run("save-some-buffers")).resolves.toBeUndefined()

    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("x")
    expect(await readFile(join(dir, "c.txt"), "utf8")).toBe("x") // loop continued past b
    expect(lastMessage).toMatch(/Saved 2 of 3/)
    expect(lastMessage).toMatch(/1 failed/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
