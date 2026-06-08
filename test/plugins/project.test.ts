import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { makeEditor } from "./helper"
import { setCustom } from "../../src/runtime/custom"
import { spawnProcess } from "../../src/platform/runtime"
import {
  install,
  projectCurrent,
  projectFiles,
  projectRoot,
  readProjectList,
  rememberProject,
  writeProjectList,
} from "../../plugins/project"

let dir: string
let repo: string
let listFile: string

async function git(args: string[], cwd: string): Promise<void> {
  const proc = spawnProcess({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" })
  await proc.exited
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jemacs-project-"))
  repo = join(dir, "repo")
  listFile = join(dir, "projects.json")
  await mkdir(join(repo, "src", "deep"), { recursive: true })
  await git(["init", "-q"], repo)
  await writeFile(join(repo, "README.md"), "hello\n")
  await writeFile(join(repo, "src", "a.ts"), "export const a = 1\n")
  await writeFile(join(repo, "src", "deep", "b.ts"), "export const b = 2\n")
  await git(["add", "."], repo)
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function ed() {
  const editor = makeEditor()
  install(editor)
  setCustom("project-list-file", listFile)
  return editor
}

test("projectRoot walks up from a nested directory to .git", async () => {
  expect(await projectRoot(join(repo, "src", "deep"))).toBe(resolve(repo))
  expect(await projectRoot(repo)).toBe(resolve(repo))
})

test("projectRoot returns null when no .git is found", async () => {
  const island = join(dir, "no-vc")
  await mkdir(island, { recursive: true })
  expect(await projectRoot(island)).toBeNull()
})

test("projectFiles lists git-tracked files relative to root", async () => {
  const files = await projectFiles(repo)
  expect(files.sort()).toEqual(["README.md", "src/a.ts", "src/deep/b.ts"])
})

test("install registers commands and C-x p bindings", () => {
  const editor = ed()
  for (const cmd of ["project-current", "project-root", "project-find-file", "project-switch-project", "project-compile"]) {
    expect(editor.commands.get(cmd)).toBeDefined()
  }
  expect(editor.commands.get("project-current")?.interactive).toBeUndefined()
  expect(editor.commands.get("project-root")?.interactive).toBeUndefined()
  expect(editor.commands.get("project-find-file")?.interactive).toBe(true)
  expect(editor.keymap.get("C-x p f")).toBe("project-find-file")
  expect(editor.keymap.get("C-x p p")).toBe("project-switch-project")
  expect(editor.keymap.get("C-x p c")).toBe("project-compile")
})

test("rememberProject dedupes and moves to front; readProjectList round-trips", async () => {
  ed()
  await writeProjectList(["/a", "/b", "/c"])
  await rememberProject("/b")
  expect(await readProjectList()).toEqual(["/b", "/a", "/c"])
  await rememberProject("/d")
  expect(await readProjectList()).toEqual(["/d", "/b", "/a", "/c"])
  await rememberProject("/d")
  expect(await readProjectList()).toEqual(["/d", "/b", "/a", "/c"])
})

test("readProjectList tolerates missing or malformed file", async () => {
  ed()
  expect(await readProjectList()).toEqual([])
  await writeFile(listFile, "{not json", "utf8")
  expect(await readProjectList()).toEqual([])
})

test("project-current returns the current root quietly", async () => {
  const editor = ed()
  await editor.openFile(join(repo, "src", "a.ts"))
  let messaged = false
  editor.events.on("message", () => { messaged = true })

  expect(await projectCurrent(editor)).toBe(resolve(repo))
  expect(await editor.run("project-current")).toBe(resolve(repo))
  expect(messaged).toBe(false)
})

test("project-current returns null quietly outside any repo", async () => {
  const editor = ed()
  const island = join(dir, "no-vc")
  await mkdir(island, { recursive: true })
  let messaged = false
  editor.events.on("message", () => { messaged = true })

  expect(await projectCurrent(editor, { directory: island })).toBeNull()
  expect(await editor.run("project-current", [island])).toBeNull()
  expect(messaged).toBe(false)
})

test("project-root echoes the discovered root from a buffer inside the repo", async () => {
  const editor = ed()
  await editor.openFile(join(repo, "src", "a.ts"))
  let last = ""
  editor.events.on("message", ({ text }) => { last = text })
  const result = await editor.run("project-root")
  expect(result).toBe(resolve(repo))
  expect(last).toBe(resolve(repo))
})

test("project-root returns an explicit project root without messaging", async () => {
  const editor = ed()
  let messaged = false
  editor.events.on("message", () => { messaged = true })

  expect(await editor.run("project-root", [repo])).toBe(resolve(repo))
  expect(messaged).toBe(false)
})

test("project-find-file completes over git ls-files and opens the chosen file", async () => {
  const editor = ed()
  await editor.openFile(join(repo, "src", "deep", "b.ts"))

  let seen: string[] | undefined
  editor.completingRead = (_prompt, opts) => {
    seen = opts.collection
    return Promise.resolve("src/a.ts")
  }
  await editor.run("project-find-file")

  expect(seen?.sort()).toEqual(["README.md", "src/a.ts", "src/deep/b.ts"])
  expect(editor.currentBuffer.path).toBe(resolve(repo, "src", "a.ts"))
  expect(editor.currentBuffer.text).toBe("export const a = 1\n")

  const list = JSON.parse(await readFile(listFile, "utf8")) as string[]
  expect(list[0]).toBe(resolve(repo))
})

test("project-find-file outside any repo just messages", async () => {
  const editor = ed()
  const island = join(dir, "no-vc")
  await mkdir(island, { recursive: true })
  let last = ""
  editor.events.on("message", ({ text }) => { last = text })
  let prompted = false
  editor.completingRead = () => { prompted = true; return Promise.resolve(null) }
  await editor.run("project-find-file", [island])
  expect(last).toContain("No project found")
  expect(prompted).toBe(false)
})

test("project-switch-project picks from project-list-file then dispatches find-file", async () => {
  const editor = ed()
  const other = join(dir, "other")
  await mkdir(other, { recursive: true })
  await writeProjectList([other, resolve(repo)])

  const prompts: Array<{ prompt: string; collection: string[] | undefined }> = []
  editor.completingRead = (prompt, opts) => {
    prompts.push({ prompt, collection: opts.collection })
    if (prompt.startsWith("Switch to project")) return Promise.resolve(resolve(repo))
    return Promise.resolve("README.md")
  }
  await editor.run("project-switch-project")

  expect(prompts[0]!.collection).toEqual([other, resolve(repo)])
  expect(prompts[1]!.prompt).toContain("Find file in project")
  expect(editor.currentBuffer.path).toBe(resolve(repo, "README.md"))
  expect((await readProjectList())[0]).toBe(resolve(repo))
})

test("project-switch-project with empty list messages and does not prompt", async () => {
  const editor = ed()
  let last = ""
  editor.events.on("message", ({ text }) => { last = text })
  let prompted = false
  editor.completingRead = () => { prompted = true; return Promise.resolve(null) }
  await editor.run("project-switch-project")
  expect(last).toContain("No known projects")
  expect(prompted).toBe(false)
})

test("project-compile runs the command in root and writes *compilation*", async () => {
  const editor = ed()
  await editor.openFile(join(repo, "src", "a.ts"))
  await editor.run("project-compile", ["echo built && pwd"])

  const buf = editor.currentBuffer
  expect(buf.name).toBe("*compilation*")
  expect(buf.text).toContain("echo built && pwd")
  expect(buf.text).toContain("built")
  expect(buf.text).toContain(resolve(repo))
  expect(buf.text).toContain("Compilation finished")
})

test("project-compile reports a non-zero exit", async () => {
  const editor = ed()
  await editor.openFile(join(repo, "README.md"))
  let last = ""
  editor.events.on("message", ({ text }) => { last = text })
  await editor.run("project-compile", ["sh -c 'exit 3'"])
  expect(last).toContain("exited abnormally with code 3")
  expect(editor.currentBuffer.text).toContain("exited abnormally with code 3")
})
