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
  projectDirectories,
  projectFiles,
  projectBuffers,
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
  setCustom("project-switch-commands", [
    ["project-find-file", "Find file"],
    ["project-find-regexp", "Find regexp"],
    ["project-find-dir", "Find directory"],
    ["project-vc-dir", "VC-Dir"],
    ["project-eshell", "Eshell"],
  ])
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

test("projectDirectories lists tracked project directories relative to root", async () => {
  expect(await projectDirectories(repo)).toEqual([".", "src", "src/deep"])
})

test("install registers commands and C-x p bindings", () => {
  const editor = ed()
  for (const cmd of ["project-current", "project-root", "project-find-file", "project-find-regexp", "project-find-dir", "project-switch-project", "project-dired", "project-vc-dir", "project-kill-buffers", "project-compile", "vc-dir"]) {
    expect(editor.commands.get(cmd)).toBeDefined()
  }
  expect(editor.commands.get("project-current")?.interactive).toBeUndefined()
  expect(editor.commands.get("project-root")?.interactive).toBeUndefined()
  expect(editor.commands.get("project-find-file")?.interactive).toBe(true)
  expect(editor.keymap.get("C-x p f")).toBe("project-find-file")
  expect(editor.keymap.get("C-x p g")).toBe("project-find-regexp")
  expect(editor.keymap.get("C-x p d")).toBe("project-find-dir")
  expect(editor.keymap.get("C-x p p")).toBe("project-switch-project")
  expect(editor.keymap.get("C-x p v")).toBe("project-vc-dir")
  expect(editor.keymap.get("C-x p S-d")).toBe("project-dired")
  expect(editor.keymap.get("C-x p c")).toBe("project-compile")
  expect(editor.keymap.get("C-x p k")).toBe("project-kill-buffers")
  expect(editor.keymap.get("C-x v d")).toBe("vc-dir")
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

test("project-find-dir completes over project directories and opens Dired", async () => {
  const editor = ed()
  await editor.openFile(join(repo, "src", "a.ts"))

  let seen: string[] | undefined
  editor.completingRead = (_prompt, opts) => {
    seen = opts.collection
    return Promise.resolve("src/deep")
  }
  await editor.run("project-find-dir")

  expect(seen).toEqual([".", "src", "src/deep"])
  expect(editor.currentBuffer.kind).toBe("directory")
  expect(editor.currentBuffer.path).toBe(resolve(repo, "src", "deep"))
  expect((await readProjectList())[0]).toBe(resolve(repo))
})

test("project-find-regexp searches from the project root and populates grep results", async () => {
  const editor = ed()
  await editor.openFile(join(repo, "src", "a.ts"))

  await editor.run("project-find-regexp", ["export"])

  expect(editor.currentBuffer.name).toBe("*grep*")
  expect(editor.currentBuffer.kind).toBe("grep")
  expect(editor.currentBuffer.locals.get("default-directory")).toBe(resolve(repo))
  expect(editor.currentBuffer.text).toContain("src/a.ts")
  expect(editor.currentBuffer.text).toContain("src/deep/b.ts")
  expect((await readProjectList())[0]).toBe(resolve(repo))
})

test("project-switch-project picks a project then dispatches project-switch-commands", async () => {
  const editor = ed()
  const other = join(dir, "other")
  await mkdir(other, { recursive: true })
  await writeProjectList([other, resolve(repo)])

  const prompts: Array<{ prompt: string; collection: string[] | undefined }> = []
  editor.completingRead = (prompt, opts) => {
    prompts.push({ prompt, collection: opts.collection })
    if (prompt.startsWith("Switch to project")) return Promise.resolve(resolve(repo))
    if (prompt.startsWith("Run project command")) return Promise.resolve("Find file (project-find-file)")
    return Promise.resolve("README.md")
  }
  await editor.run("project-switch-project")

  expect(prompts[0]!.collection).toEqual([other, resolve(repo)])
  expect(prompts[1]).toEqual({
    prompt: "Run project command: ",
    collection: ["Find file (project-find-file)", "Find regexp (project-find-regexp)", "Find directory (project-find-dir)", "VC-Dir (project-vc-dir)"],
  })
  expect(prompts[2]!.prompt).toContain("Find file in project")
  expect(editor.currentBuffer.path).toBe(resolve(repo, "README.md"))
  expect((await readProjectList())[0]).toBe(resolve(repo))
})

test("project-switch-project can dispatch project-find-regexp for the selected root", async () => {
  const editor = ed()
  await writeProjectList([resolve(repo)])

  const prompts: Array<{ prompt: string; collection: string[] | undefined }> = []
  editor.completingRead = (prompt, opts) => {
    prompts.push({ prompt, collection: opts.collection })
    if (prompt.startsWith("Switch to project")) return Promise.resolve(resolve(repo))
    if (prompt.startsWith("Run project command")) return Promise.resolve("Find regexp (project-find-regexp)")
    throw new Error(`unexpected completing-read: ${prompt}`)
  }
  editor.prompt = prompt => {
    prompts.push({ prompt, collection: undefined })
    return Promise.resolve("hello")
  }

  await editor.run("project-switch-project")

  expect(prompts.map(p => p.prompt)).toEqual([
    "Switch to project: ",
    "Run project command: ",
    "Find regexp in project: ",
  ])
  expect(editor.currentBuffer.name).toBe("*grep*")
  expect(editor.currentBuffer.locals.get("default-directory")).toBe(resolve(repo))
  expect(editor.currentBuffer.text).toContain("README.md")
})

test("vc-dir delegates to magit-status when it is available", async () => {
  const editor = ed()
  let seen: string | undefined
  editor.command("magit-status", ({ args }) => {
    seen = args[0]
  })

  await editor.run("vc-dir", [repo])

  expect(seen).toBe(repo)
})

test("project-vc-dir runs VC status at the current project root", async () => {
  const editor = ed()
  await editor.openFile(join(repo, "src", "a.ts"))
  let seen: string | undefined
  editor.command("magit-status", ({ args }) => {
    seen = args[0]
  })

  await editor.run("project-vc-dir")

  expect(seen).toBe(resolve(repo))
  expect((await readProjectList())[0]).toBe(resolve(repo))
})

test("projectBuffers includes file and project-local special buffers", async () => {
  const editor = ed()
  await editor.openFile(join(repo, "src", "a.ts"))
  await editor.openFile(join(repo, "src", "deep", "b.ts"))
  const grep = editor.scratch("*grep*", "", "grep")
  grep.locals.set("default-directory", resolve(repo))
  const magit = editor.scratch("*magit*", "", "magit-status")
  magit.locals.set("magit-root", resolve(repo))
  const other = editor.scratch("notes", "", "text")

  const buffers = await projectBuffers(editor, resolve(repo))

  expect(buffers.map(b => b.name).sort()).toEqual(["*grep*", "*magit*", "a.ts", "b.ts"])
  expect(buffers).not.toContain(other)
})

test("project-kill-buffers kills buffers in the current project", async () => {
  const editor = ed()
  const outside = join(dir, "outside.txt")
  await writeFile(outside, "outside\n")
  await editor.openFile(join(repo, "src", "a.ts"))
  await editor.openFile(join(repo, "src", "deep", "b.ts"))
  await editor.openFile(outside)
  const grep = editor.scratch("*grep*", "", "grep")
  grep.locals.set("default-directory", resolve(repo))

  await editor.run("project-kill-buffers", [repo, "no-confirm"])

  expect([...editor.buffers.values()].some(b => b.path?.startsWith(resolve(repo)))).toBe(false)
  expect([...editor.buffers.values()].some(b => b.name === "*grep*")).toBe(false)
  expect([...editor.buffers.values()].some(b => b.path === resolve(outside))).toBe(true)
})

test("project-kill-buffers no-confirm argument uses the current project", async () => {
  const editor = ed()
  await editor.openFile(join(repo, "src", "a.ts"))

  await editor.run("project-kill-buffers", ["no-confirm"])

  expect([...editor.buffers.values()].some(b => b.path === resolve(repo, "src", "a.ts"))).toBe(false)
})

test("project-kill-buffers asks before killing interactively", async () => {
  const editor = ed()
  await editor.openFile(join(repo, "src", "a.ts"))
  editor.prompt = () => Promise.resolve("n")

  await editor.run("project-kill-buffers", [repo])

  expect([...editor.buffers.values()].some(b => b.path === resolve(repo, "src", "a.ts"))).toBe(true)
})

test("project-switch-project honors customized project-switch-commands", async () => {
  const editor = ed()
  setCustom("project-switch-commands", [["project-dired", "Dired only"], ["missing-command", "Missing"]])
  await writeProjectList([resolve(repo)])

  const prompts: Array<{ prompt: string; collection: string[] | undefined }> = []
  editor.completingRead = (prompt, opts) => {
    prompts.push({ prompt, collection: opts.collection })
    if (prompt.startsWith("Switch to project")) return Promise.resolve(resolve(repo))
    return Promise.resolve("Dired only (project-dired)")
  }
  await editor.run("project-switch-project")

  expect(prompts[1]).toEqual({
    prompt: "Run project command: ",
    collection: ["Dired only (project-dired)"],
  })
  expect(editor.currentBuffer.kind).toBe("directory")
  expect(editor.currentBuffer.path).toBe(resolve(repo))
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

test("project-dired opens the current project root in Dired", async () => {
  const editor = ed()
  await editor.openFile(join(repo, "src", "a.ts"))

  await editor.run("project-dired")

  expect(editor.currentBuffer.kind).toBe("directory")
  expect(editor.currentBuffer.path).toBe(resolve(repo))
  expect((await readProjectList())[0]).toBe(resolve(repo))
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
