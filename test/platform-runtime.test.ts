import { afterEach, expect, test } from "bun:test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BufferModel } from "../src/kernel/buffer"
import {
  cwd,
  env,
  hash,
  homedir,
  nodeRuntime,
  readFileText,
  readdir,
  setPlatformRuntime,
  stat,
  watch,
  whichExecutable,
  writeFileText,
  type PlatformRuntime,
} from "../src/platform/runtime"

afterEach(() => setPlatformRuntime(undefined))

test("readFileText and writeFileText work without Bun", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-platform-"))
  const path = join(dir, "sample.txt")
  await writeFileText(path, "hello electron")
  expect(await readFileText(path)).toBe("hello electron")
  await rm(dir, { recursive: true })
})

test("BufferModel.fromFile uses platform I/O", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-fromfile-"))
  const path = join(dir, "open-me.ts")
  await writeFile(path, "export const x = 1\n", "utf8")
  const buffer = await BufferModel.fromFile(path)
  expect(buffer.text).toBe("export const x = 1\n")
  expect(buffer.name).toBe("open-me.ts")
  await rm(dir, { recursive: true })
})

test("whichExecutable resolves common tools when present", () => {
  const node = whichExecutable("node")
  expect(node == null || node.length > 0).toBe(true)
})

test("nodeRuntime is a complete PlatformRuntime", () => {
  // Type-level: this line fails to compile if nodeRuntime is missing a method.
  const rt: PlatformRuntime = nodeRuntime
  // Value-level: every key is a function (no accidental `undefined`).
  for (const k of Object.keys(rt) as Array<keyof PlatformRuntime>) {
    expect(typeof rt[k]).toBe("function")
  }
})

test("hash is sha256 hex and stable across runtime impls", () => {
  expect(hash("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
  expect(hash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  expect(nodeRuntime.hash("abc")).toBe(hash("abc"))
})

test("cwd/env/homedir mirror process without importing it", () => {
  expect(cwd()).toBe(process.cwd())
  expect(env("PATH")).toBe(process.env.PATH)
  expect(env("__JEMACS_DEFINITELY_UNSET__")).toBeUndefined()
  expect(homedir().length).toBeGreaterThan(0)
})

test("stat/readdir surface the Node fs through the seam", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-stat-"))
  const path = join(dir, "f.txt")
  await writeFile(path, "xy", "utf8")
  const s = await stat(path)
  expect(s?.size).toBe(2)
  expect((await readdir(dir)).sort()).toEqual(["f.txt"])
  expect(await stat(join(dir, "missing"))).toBeNull()
  await rm(dir, { recursive: true })
})

test("watch fires on change and close() stops it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-watch-"))
  const path = join(dir, "w.txt")
  await writeFile(path, "a", "utf8")
  let fired = 0
  const handle = watch(path, () => { fired++ })
  await writeFile(path, "b", "utf8")
  // Poll instead of sleeping a fixed 50ms. This waits on a real OS filesystem event,
  // which under a loaded suite arrives later than any constant worth hardcoding. The
  // 4s ceiling stays below bun's 5s per-test timeout, so a watcher that never fires
  // still reports as the assertion below failing rather than as a test timeout.
  const deadline = Date.now() + 4_000
  while (fired === 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10))
  }
  expect(fired).toBeGreaterThan(0)
  handle.close()
  await rm(dir, { recursive: true })
})

test("free functions route through setPlatformRuntime override", async () => {
  const calls: string[] = []
  setPlatformRuntime({
    hash: t => { calls.push("hash"); return `fake:${t.length}` },
    cwd: () => { calls.push("cwd"); return "/remote/root" },
    env: n => { calls.push(`env:${n}`); return n === "SHELL" ? "/bin/remote" : undefined },
    watch: () => { calls.push("watch"); return { close: () => calls.push("close") } },
    readFileText: async () => { calls.push("read"); return "remote-text" },
  })
  expect(hash("hello")).toBe("fake:5")
  expect(cwd()).toBe("/remote/root")
  expect(env("SHELL")).toBe("/bin/remote")
  const h = watch("/x", () => {})
  h.close()
  expect(await readFileText("/x")).toBe("remote-text")
  // Unoverridden methods still fall through to nodeRuntime.
  expect(homedir().length).toBeGreaterThan(0)
  expect(calls).toEqual(["hash", "cwd", "env:SHELL", "watch", "close", "read"])
})
