import { afterEach, expect, test } from "bun:test"
import { Editor } from "../../src/kernel/editor"
import { BufferModel } from "../../src/kernel/buffer"
import { setPlatformRuntime } from "../../src/platform/runtime"

afterEach(() => setPlatformRuntime(undefined))

const S_IFDIR = 0o040000

// t-dog-0f8740bd: editor.ts imported {stat,unlink} from node:fs/promises,
// bypassing the PlatformRuntime seam — in --web --shadow the stub throws,
// so find-file on a directory never reached dired and auto-save cleanup
// never hit the remote.
test("openFile consults PlatformRuntime.stat for the directory check", async () => {
  const stats: string[] = []
  setPlatformRuntime({
    stat: async p => { stats.push(p); return { mode: S_IFDIR | 0o755, size: 0, mtime: 0 } },
    readdir: async () => [],
    readFileText: async () => "",
  })
  const buf = await new Editor().openFile("/remote/project")
  expect(stats).toContain("/remote/project")
  expect(buf.kind).toBe("directory")
})

test("deleteAutoSaveFile routes through PlatformRuntime.unlink", async () => {
  const unlinked: string[] = []
  setPlatformRuntime({ unlink: async p => { unlinked.push(p) } })
  const ed = new Editor()
  const buf = new BufferModel({ name: "f.txt", path: "/remote/f.txt", kind: "file" })
  ed.addBuffer(buf)
  await ed.deleteAutoSaveFile(buf)
  expect(unlinked).toEqual(["/remote/#f.txt#"])
})
