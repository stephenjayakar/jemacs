import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { makeEditor } from "../test/plugins/helper"
import { install as installVertico } from "../plugins/vertico"
import { install as installCompile } from "../plugins/compile"
import { install as installNextError } from "../plugins/next-error"
import { install as installPersist } from "../plugins/persist"
import { getCustom, setCustom } from "../src/runtime/custom"
import { spawnProcess } from "../src/platform/runtime"
const packagesDir = process.env.JEMACS_PACKAGES ?? join(homedir(), ".jemacs", "packages")
const {
  install,
  projectileProjectFiles,
  projectileProjectRoot,
  projectileKnownProjects,
  resetProjectileStateForTests,
} = await import(join(packagesDir, "projectile/projectile.ts"))

let dir: string
let repo: string
let bookmarks: string

async function git(args: string[], cwd: string): Promise<void> {
  const proc = spawnProcess({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" })
  await proc.exited
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jemacs-projectile-"))
  repo = join(dir, "repo")
  bookmarks = join(dir, "bookmarks.json")
  await mkdir(join(repo, "src"), { recursive: true })
  await git(["init", "-q"], repo)
  await writeFile(join(repo, "README.md"), "hello\n")
  await writeFile(join(repo, "src", "a.ts"), "export const a = 1\n")
  await git(["add", "."], repo)
})

afterEach(async () => {
  resetProjectileStateForTests()
  await rm(dir, { recursive: true, force: true })
})

async function ed() {
  const editor = makeEditor()
  installVertico(editor)
  installCompile(editor)
  installNextError(editor)
  installPersist(editor)
  editor.enableMinorMode("vertico-mode")
  await install(editor)
  setCustom("projectile-known-projects-file", bookmarks)
  resetProjectileStateForTests()
  return editor
}

test("projectileProjectRoot finds .git from nested path", async () => {
  expect(await projectileProjectRoot(join(repo, "src"))).toBe(resolve(repo))
})

test("projectileProjectFiles lists git-tracked files", async () => {
  const files = await projectileProjectFiles(repo, spawnProcess, getCustom)
  expect(files).toEqual(["README.md", "src/a.ts"])
})

test("install registers C-c p f as projectile-find-file", async () => {
  const editor = await ed()
  const minor = editor.activeMinorModes().find(m => m.name === "projectile-mode")
  expect(minor).toBeDefined()
  expect(minor!.keymap!.get("C-c p f")).toBe("projectile-find-file")
  expect(minor!.keymap!.get("C-c p p")).toBe("projectile-switch-project")
})

test("projectile-find-file completes and opens a project file", async () => {
  const editor = await ed()
  await editor.openFile(join(repo, "src", "a.ts"))

  let seen: string[] | undefined
  editor.completingRead = (_prompt, opts) => {
    seen = opts.collection
    return Promise.resolve("README.md")
  }
  await editor.run("projectile-find-file")

  expect(seen?.sort()).toEqual(["README.md", "src/a.ts"])
  expect(editor.currentBuffer.path).toBe(resolve(repo, "README.md"))
  const list = await projectileKnownProjects(getCustom)
  expect(list[0]).toBe(resolve(repo))
})

test("projectile-find-file prompt includes project name", async () => {
  const editor = await ed()
  await editor.openFile(join(repo, "README.md"))
  let prompt = ""
  editor.completingRead = (p, opts) => {
    prompt = p
    return Promise.resolve(opts.collection?.[0] ?? null)
  }
  await editor.run("projectile-find-file")
  expect(prompt).toMatch(/\[repo\] Find file:/)
})

test("projectile-switch-project dispatches projectile-find-file", async () => {
  const editor = await ed()
  const other = join(dir, "other")
  await mkdir(other, { recursive: true })
  await writeFile(bookmarks, JSON.stringify([other, resolve(repo)]), "utf8")

  const prompts: string[] = []
  editor.completingRead = (prompt, opts) => {
    prompts.push(prompt)
    if (prompt.includes("Switch to project")) return Promise.resolve(resolve(repo))
    return Promise.resolve("src/a.ts")
  }
  await editor.run("projectile-switch-project")

  expect(prompts[0]).toContain("Switch to project")
  expect(prompts[1]).toMatch(/Find file:/)
  expect(editor.currentBuffer.path).toBe(resolve(repo, "src/a.ts"))
})
