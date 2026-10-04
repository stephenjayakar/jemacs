import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Editor } from "../src/kernel/editor"
import { completionStyleMatches, completionStylesFor, fileCompletionCandidates, splitCompletionInput } from "../src/kernel/completion"
import { setPlatformRuntime } from "../src/platform/runtime"
import { resetCustom, setCustom } from "../src/runtime/custom"

afterEach(() => {
  setPlatformRuntime(undefined)
  resetCustom("completion-styles")
  resetCustom("completion-category-overrides")
})

test("completion styles: the first style with matches wins", () => {
  const names = ["kanto spire", "spire notes", "other"]
  expect(completionStyleMatches(names, "spire", ["basic"])).toEqual(["spire notes"])
  expect(completionStyleMatches(names, "kanto s", ["basic", "substring"])).toEqual(["kanto spire"])
  expect(completionStyleMatches(names, "pire", ["basic", "substring"])).toEqual(["kanto spire", "spire notes"])
  expect(completionStyleMatches(names, "spire", ["substring", "basic"])).toEqual(["kanto spire", "spire notes"])
})

// Editor setup declares completion-styles and completion-category-overrides.
new Editor()

test("completion-category-overrides picks file styles over completion-styles", () => {
  setCustom("completion-styles", ["basic", "partial-completion", "emacs22"])
  setCustom("completion-category-overrides", [["file", ["styles", "substring", "basic"]]])
  expect(completionStylesFor("file")).toEqual(["substring", "basic"])
  expect(completionStylesFor("command")).toEqual(["basic", "partial-completion", "emacs22"])
  expect(completionStylesFor()).toEqual(["basic", "partial-completion", "emacs22"])
})

test("find-file completion matches mid-name with a substring file override", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-substring-"))
  await mkdir(join(dir, "kanto spire"))
  await writeFile(join(dir, "spire.md"), "")
  await writeFile(join(dir, "other.md"), "")
  setCustom("completion-styles", ["basic", "partial-completion", "emacs22"])
  expect(await fileCompletionCandidates(`${dir}/spire`)).toEqual([`${dir}/spire.md`])
  setCustom("completion-category-overrides", [["file", ["styles", "substring", "basic"]]])
  expect((await fileCompletionCandidates(`${dir}/spire`)).sort()).toEqual([`${dir}/kanto spire/`, `${dir}/spire.md`])
})

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
