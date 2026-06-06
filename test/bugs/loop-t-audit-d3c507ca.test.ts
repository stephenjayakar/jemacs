import { expect, test } from "bun:test"
import { script } from "../harness"
import { BufferModel } from "../../src/kernel/buffer"

// t-audit-d3c507ca: save-some-buffers must not abort the loop when one b.save() throws.
// Per-buffer failures are caught, the remaining buffers still save, and the final
// message reports a summary of what failed.
test("save-some-buffers continues past a failing save and reports a summary", async () => {
  const ed = await script().done()
  let lastMessage = ""
  ed.events.on("message", ({ text }) => { lastMessage = text })

  const mk = (name: string) => {
    const b = new BufferModel({ name, path: `/tmp/${name}`, kind: "file" })
    b.dirty = true
    ed.addBuffer(b)
    return b
  }
  const a = mk("a.txt")
  const b = mk("b.txt")
  const c = mk("c.txt")

  const saved: string[] = []
  a.save = async () => { saved.push("a"); a.dirty = false }
  b.save = async () => { throw new Error("disk full") }
  c.save = async () => { saved.push("c"); c.dirty = false }

  ed.prompt = async () => "!"
  await ed.run("save-some-buffers")

  expect(saved).toEqual(["a", "c"])
  expect(c.dirty).toBe(false)
  expect(lastMessage).toContain("Saved 2 of 3")
  expect(lastMessage).toContain("1 failed")
  expect(lastMessage).toContain("disk full")
})
