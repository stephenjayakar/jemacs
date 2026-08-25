import { afterEach, expect, test } from "bun:test"
import { fileCompletionCandidates, splitCompletionInput } from "../src/kernel/completion"
import { setPlatformRuntime } from "../src/platform/runtime"

afterEach(() => setPlatformRuntime(undefined))

test("splitCompletionInput separates directory and filename prefix", () => {
  expect(splitCompletionInput("/tmp/foo")).toEqual({ directory: "/tmp/", prefix: "foo" })
  expect(splitCompletionInput("foo")).toEqual({ directory: process.cwd(), prefix: "foo" })
})

test("fileCompletionCandidates lists entries in a directory", async () => {
  const candidates = await fileCompletionCandidates(`${process.cwd()}/`)
  expect(candidates.length).toBeGreaterThan(0)
  expect(candidates.some(candidate => candidate.endsWith("/"))).toBe(true)
})

test("fileCompletionCandidates returns no candidates for remote-looking paths", async () => {
  await expect(fileCompletionCandidates("/ssh:user@192.168.0.29:/")).resolves.toEqual([])
  await expect(fileCompletionCandidates("/scp:user@example.com:/tmp/")).resolves.toEqual([])
  await expect(fileCompletionCandidates("/sudo::/etc/")).resolves.toEqual([])
})

test("fileCompletionCandidates survives readdir errors", async () => {
  setPlatformRuntime({
    cwd: () => process.cwd(),
    homedir: () => process.env.HOME ?? "/tmp",
    readdir: async () => { throw new Error("ENOENT") },
  })
  await expect(fileCompletionCandidates("/definitely/not/a/directory/")).resolves.toEqual([])
})
