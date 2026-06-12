import { afterEach, expect, test } from "bun:test"
import { setPlatformRuntime, type StatLike } from "../../src/platform/runtime"
import { fileCompletionCandidates } from "../../src/kernel/completion"
import { makeDiredBuffer } from "../../src/modes/dired"
import { BufferModel } from "../../src/kernel/buffer"

// t-dog-3bf39228: dired.ts/completion.ts/buffer.ts import node:fs/promises directly,
// bypassing the PlatformRuntime seam. In the browser shadow those imports resolve to
// node-stubs.ts and throw NotImplementedInBrowser, so dired and find-file completion
// fail even though RemoteRuntime supplies a working readdir/stat over the link.
//
// Repro: install a virtual-fs override and assert the calls see it. Before the fix
// they hit real node:fs, so /v/* (which doesn't exist on disk) yields nothing.

afterEach(() => setPlatformRuntime(undefined))

const S_IFDIR = 0o040000
const S_IFREG = 0o100644
const vfs: Record<string, StatLike> = {
  "/v": { mode: S_IFDIR, size: 0, mtime: 0 },
  "/v/a.txt": { mode: S_IFREG, size: 3, mtime: 1000 },
  "/v/sub": { mode: S_IFDIR, size: 0, mtime: 1000 },
}
function installVfs(extra: { mkdir?: (p: string) => void } = {}) {
  setPlatformRuntime({
    readdir: async dir => Object.keys(vfs).filter(p => p !== dir && p.startsWith(dir + "/") && !p.slice(dir.length + 1).includes("/")).map(p => p.slice(dir.length + 1)),
    stat: async p => vfs[p] ?? null,
    fileExists: async p => p in vfs,
    readFileText: async () => "xyz",
    writeFileText: async () => {},
    mkdir: async p => extra.mkdir?.(p),
    cp: async () => {},
    homedir: () => "/v",
    cwd: () => "/v",
  })
}

test("t-dog-3bf39228: fileCompletionCandidates routes through PlatformRuntime", async () => {
  installVfs()
  const cands = await fileCompletionCandidates("/v/")
  expect(cands.sort()).toEqual(["/v/a.txt", "/v/sub/"])
})

test("t-dog-3bf39228: makeDiredBuffer routes readdir/stat through PlatformRuntime", async () => {
  installVfs()
  const buf = await makeDiredBuffer("/v")
  expect(buf.text).toContain("a.txt")
  expect(buf.text).toContain("sub/")
})

test("t-dog-3bf39228: BufferModel.save routes backup mkdir/copy through PlatformRuntime", async () => {
  const made: string[] = []
  installVfs({ mkdir: p => made.push(p) })
  const buf = new BufferModel({ name: "a.txt", path: "/v/a.txt", text: "xyz", kind: "file" })
  buf.insert("!")
  await buf.save({ force: true, backupDirectoryAlist: [[".", "/v/bak"]] })
  expect(made).toContain("/v/bak")
})
