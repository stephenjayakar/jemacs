import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnProcess } from "../../src/platform/runtime"
import { makeEditor } from "./helper"
import {
  install,
  parsePorcelainV1,
  setVcBackend,
  vcDirState,
} from "../../plugins/vc-dir"

let dir: string
let repo: string

async function git(args: string[], cwd = repo): Promise<string> {
  const proc = spawnProcess({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" })
  const [out, err] = await Promise.all([
    proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
    proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
  ])
  const code = await proc.exited
  if (code !== 0) throw new Error(err || `git ${args.join(" ")} failed`)
  return out
}

async function makeRepo(): Promise<void> {
  await mkdir(repo, { recursive: true })
  await git(["init", "-q"])
  await git(["config", "user.email", "test@example.com"])
  await git(["config", "user.name", "test"])
  await writeFile(join(repo, "tracked.txt"), "base\n")
  await writeFile(join(repo, "deleted.txt"), "delete me\n")
  await git(["add", "."])
  await git(["commit", "-q", "-m", "initial"])
  await writeFile(join(repo, "tracked.txt"), "base\nmodified\n")
  await rm(join(repo, "deleted.txt"))
  await writeFile(join(repo, "new.txt"), "new\n")
  await writeFile(join(repo, "added.txt"), "added\n")
  await git(["add", "added.txt"])
}

function editorWithVcDir() {
  const editor = makeEditor()
  install(editor)
  return editor
}

function moveToLineContaining(buffer: { text: string; lineStarts: readonly number[]; point: number }, needle: string): void {
  const line = buffer.text.split("\n").findIndex(row => row.includes(needle))
  expect(line).toBeGreaterThanOrEqual(0)
  buffer.point = buffer.lineStarts[line] ?? 0
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jemacs-vc-dir-"))
  repo = join(dir, "repo")
  await makeRepo()
})

afterEach(async () => {
  setVcBackend(undefined)
  await rm(dir, { recursive: true, force: true })
})

describe("vc-dir", () => {
  test("parsePorcelainV1 maps git states", () => {
    expect(parsePorcelainV1([
      " M edited.txt",
      "A  added.txt",
      " D removed.txt",
      "?? new.txt",
      "UU conflict.txt",
      "R  old.txt -> renamed.txt",
      "",
    ].join("\n"))).toEqual([
      { file: "edited.txt", state: "edited", xy: " M" },
      { file: "added.txt", state: "added", xy: "A " },
      { file: "removed.txt", state: "removed", xy: " D" },
      { file: "new.txt", state: "untracked", xy: "??" },
      { file: "conflict.txt", state: "conflict", xy: "UU" },
      { file: "renamed.txt", state: "edited", xy: "R " },
    ])
  })

  test("opens a vc-dir-mode tabulated status buffer for the current repo", async () => {
    const editor = editorWithVcDir()
    await editor.openFile(join(repo, "tracked.txt"))

    await editor.run("vc-dir")

    const buffer = editor.currentBuffer
    expect(buffer.name).toBe("*vc-dir*")
    expect(buffer.mode).toBe("vc-dir-mode")
    expect(buffer.readOnly).toBe(true)
    expect(vcDirState(buffer)?.root).toBe(await realpath(repo))
    expect(buffer.text).toContain("mark")
    expect(buffer.text).toContain("state")
    expect(buffer.text).toContain("file")
    expect(buffer.text).toContain("edited")
    expect(buffer.text).toContain("tracked.txt")
    expect(buffer.text).toContain("added")
    expect(buffer.text).toContain("added.txt")
    expect(buffer.text).toContain("removed")
    expect(buffer.text).toContain("deleted.txt")
    expect(buffer.text).toContain("untracked")
    expect(buffer.text).toContain("new.txt")
  })

  test("m and u toggle marks and RET visits the file at point", async () => {
    const editor = editorWithVcDir()
    await editor.openFile(join(repo, "tracked.txt"))
    await editor.run("vc-dir")
    const vc = editor.currentBuffer

    moveToLineContaining(vc, "tracked.txt")
    await editor.handleKey({ name: "m", sequence: "m" })

    expect(vcDirState(vc)?.marks.has("tracked.txt")).toBe(true)
    expect(vc.text.split("\n").find(row => row.includes("tracked.txt"))?.startsWith("*")).toBe(true)

    moveToLineContaining(vc, "tracked.txt")
    await editor.handleKey({ name: "u", sequence: "u" })

    expect(vcDirState(vc)?.marks.has("tracked.txt")).toBe(false)

    moveToLineContaining(vc, "tracked.txt")
    await editor.handleKey({ name: "return" })

    expect(editor.currentBuffer.path).toBe(await realpath(join(repo, "tracked.txt")))
  })

  test("= opens a diff-mode buffer for the file at point", async () => {
    const editor = editorWithVcDir()
    await editor.openFile(join(repo, "tracked.txt"))
    await editor.run("vc-dir")

    moveToLineContaining(editor.currentBuffer, "tracked.txt")
    await editor.handleKey({ name: "=", sequence: "=" })

    expect(editor.currentBuffer.name).toBe("*vc-diff*")
    expect(editor.currentBuffer.mode).toBe("diff-mode")
    expect(editor.currentBuffer.text).toContain("diff --git a/tracked.txt b/tracked.txt")
    expect(editor.currentBuffer.text).toContain("+modified")
  })

  test("v stages the current edited or untracked file and g refreshes", async () => {
    const editor = editorWithVcDir()
    await editor.openFile(join(repo, "tracked.txt"))
    await editor.run("vc-dir")
    const vc = editor.currentBuffer

    moveToLineContaining(vc, "new.txt")
    let lastMessage = ""
    editor.events.on("message", ({ text }) => { lastMessage = text })
    await editor.handleKey({ name: "v", sequence: "v" })

    expect(await git(["diff", "--cached", "--name-only"])).toContain("new.txt")
    expect(editor.currentBuffer).toBe(vc)
    expect(lastMessage).toBe("Staged 1 file")

    await writeFile(join(repo, "later.txt"), "later\n")
    await editor.handleKey({ name: "g", sequence: "g" })

    expect(vc.text).toContain("later.txt")
  })

  test("vc-dir outside a git repo messages without opening a vc buffer", async () => {
    const editor = editorWithVcDir()
    const outside = join(dir, "outside")
    await mkdir(outside)
    await writeFile(join(outside, "note.txt"), "note\n")
    await editor.openFile(join(outside, "note.txt"))
    let lastMessage = ""
    editor.events.on("message", ({ text }) => { lastMessage = text })

    await editor.run("vc-dir")

    expect(editor.currentBuffer.name).toBe("note.txt")
    expect(lastMessage).toBe("Not inside a Git repository")
    expect([...editor.buffers.values()].some(buffer => buffer.name === "*vc-dir*")).toBe(false)
  })
})
