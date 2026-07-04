import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { makeEditor } from "./helper"
import { spawnProcess } from "../../src/platform/runtime"
import { getMode } from "../../src/modes/mode"
import { buildStatus, entryAtPoint, install, magitDiffVisitTarget, parsePorcelain, type MagitEntry } from "../../plugins/magit"

let repo: string

async function git(args: string[]): Promise<string> {
  const proc = spawnProcess({ cmd: ["git", ...args], cwd: repo, stdout: "pipe", stderr: "pipe" })
  const out = proc.stdout ? await new Response(proc.stdout).text() : ""
  await proc.exited
  return out
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "jemacs-magit-"))
  await git(["init", "-q", "-b", "main"])
  await git(["config", "user.email", "test@example.com"])
  await git(["config", "user.name", "test"])
  await writeFile(join(repo, "a.txt"), "one\n")
  await writeFile(join(repo, "b.txt"), "two\n")
  await git(["add", "."])
  await git(["commit", "-q", "-m", "initial"])
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

function ed() {
  const editor = makeEditor()
  install(editor)
  return editor
}

function pointAtLine(text: string, needle: string): number {
  const i = text.indexOf(needle)
  if (i < 0) throw new Error(`not found in buffer: ${needle}`)
  return i
}

test("parsePorcelain reads branch and XY states", () => {
  const out = [
    "# branch.oid abc",
    "# branch.head main",
    "# branch.upstream origin/main",
    "1 .M N... 100644 100644 100644 h1 h2 a.txt",
    "1 M. N... 100644 100644 100644 h1 h2 b.txt",
    "? new.txt",
    "",
  ].join("\n")
  const r = parsePorcelain(out)
  expect(r.branch).toBe("main")
  expect(r.upstream).toBe("origin/main")
  expect(r.files).toEqual([
    { file: "a.txt", xy: ".M" },
    { file: "b.txt", xy: "M." },
    { file: "new.txt", xy: "??" },
  ])
})

test("install registers commands, modes and C-x g", () => {
  const editor = ed()
  for (const cmd of ["magit-status", "magit-stage", "magit-unstage", "magit-refresh", "magit-commit", "magit-commit-finish", "magit-bury-buffer", "magit-log-buffer-file", "magit-file-checkout", "magit-diff-visit-file"]) {
    expect(editor.commands.get(cmd)).toBeDefined()
  }
  expect(editor.keymap.get("C-x g")).toBe("magit-status")
  const mode = getMode("magit-status")
  expect(mode?.keymap?.get("s")).toBe("magit-stage")
  expect(mode?.keymap?.get("u")).toBe("magit-unstage")
  expect(mode?.keymap?.get("g")).toBe("magit-refresh")
  expect(mode?.keymap?.get("c c")).toBe("magit-commit")
  expect(mode?.keymap?.get("q")).toBe("magit-bury-buffer")
  expect(getMode("magit-commit")?.keymap?.get("C-c C-c")).toBe("magit-commit-finish")
})

test("magitDiffVisitTarget computes file and source line from hunk lines", () => {
  const diff = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -2,3 +2,4 @@",
    " context",
    "-old",
    "+new",
    " tail",
    "",
  ].join("\n")
  expect(magitDiffVisitTarget(diff, diff.indexOf(" context"))).toEqual({ file: "a.txt", line: 2 })
  expect(magitDiffVisitTarget(diff, diff.indexOf("-old"))).toEqual({ file: "a.txt", line: 3 })
  expect(magitDiffVisitTarget(diff, diff.indexOf("+new"))).toEqual({ file: "a.txt", line: 3 })
  const statusHunk = "@@ -10 +20 @@\n+added\n"
  expect(magitDiffVisitTarget(statusHunk, statusHunk.indexOf("+added"), "hint.txt")).toEqual({ file: "hint.txt", line: 20 })
})

test("buildStatus on a clean repo shows Head and Recent commits only", async () => {
  const s = await buildStatus(repo)
  expect(s.text).toContain("Head:     main initial")
  expect(s.text).not.toContain("Unstaged changes")
  expect(s.text).not.toContain("Staged changes")
  expect(s.text).toContain("Recent commits")
  expect(s.text).toMatch(/[0-9a-f]{7} initial/)
  expect(s.entries).toEqual([])
})

test("magit-status opens a read-only *magit: <repo>* buffer in magit-status mode", async () => {
  const editor = ed()
  await writeFile(join(repo, "a.txt"), "one\nchanged\n")
  await editor.openFile(join(repo, "a.txt"))
  await editor.run("magit-status")

  const buf = editor.currentBuffer
  expect(buf.name).toBe(`*magit: ${basename(repo)}*`)
  expect(buf.mode).toBe("magit-status")
  expect(buf.readOnly).toBe(true)
  expect(buf.locals.get("magit-root")).toBe(repo)
  expect(buf.text).toContain("Unstaged changes (1)")
  expect(buf.text).toContain("modified   a.txt")
  expect(buf.text).toContain("@@")
  expect(buf.text).toContain("+changed")
})

test("magit-log-buffer-file opens log scoped to the current file", async () => {
  const editor = ed()
  await writeFile(join(repo, "a.txt"), "one\nsecond\n")
  await git(["add", "a.txt"])
  await git(["commit", "-q", "-m", "a only"])
  await writeFile(join(repo, "b.txt"), "two\nsecond\n")
  await git(["add", "b.txt"])
  await git(["commit", "-q", "-m", "b only"])

  await editor.openFile(join(repo, "a.txt"))
  await editor.run("magit-log-buffer-file")

  expect(editor.currentBuffer.name).toBe("*magit-log*")
  expect(editor.currentBuffer.text).toContain("a only")
  expect(editor.currentBuffer.text).not.toContain("b only")
})

test("magit-file-checkout checks out current file from a revision and reverts buffer", async () => {
  const editor = ed()
  await writeFile(join(repo, "a.txt"), "second\n")
  await git(["add", "a.txt"])
  await git(["commit", "-q", "-m", "second"])
  const buffer = await editor.openFile(join(repo, "a.txt"))
  expect(buffer.text).toBe("second\n")

  await editor.run("magit-file-checkout", ["HEAD~1"])

  expect(editor.currentBuffer.path).toBe(join(repo, "a.txt"))
  expect(editor.currentBuffer.text).toBe("one\n")
})

test("magit-status outside a repo just messages", async () => {
  const editor = ed()
  const island = await mkdtemp(join(tmpdir(), "jemacs-magit-none-"))
  let last = ""
  editor.events.on("message", ({ text }) => { last = text })
  await editor.run("magit-status", [island])
  expect(last).toContain("Not inside a Git repository")
  await rm(island, { recursive: true, force: true })
})

test("s on an unstaged file stages it; u unstages it", async () => {
  const editor = ed()
  await writeFile(join(repo, "a.txt"), "one\nchanged\n")
  await editor.run("magit-status", [repo])
  let buf = editor.currentBuffer

  buf.point = pointAtLine(buf.text, "modified   a.txt")
  await editor.handleKey({ name: "s", sequence: "s" })

  expect((await git(["diff", "--cached", "--name-only"])).trim()).toBe("a.txt")
  buf = editor.currentBuffer
  expect(buf.text).toContain("Staged changes (1)")
  expect(buf.text).not.toContain("Unstaged changes")

  buf.point = pointAtLine(buf.text, "modified   a.txt")
  await editor.handleKey({ name: "u", sequence: "u" })

  expect((await git(["diff", "--cached", "--name-only"])).trim()).toBe("")
  buf = editor.currentBuffer
  expect(buf.text).toContain("Unstaged changes (1)")
  expect(buf.text).not.toContain("Staged changes")
})

test("s stages an untracked file", async () => {
  const editor = ed()
  await writeFile(join(repo, "new.txt"), "hi\n")
  await editor.run("magit-status", [repo])
  const buf = editor.currentBuffer
  expect(buf.text).toContain("untracked  new.txt")

  buf.point = pointAtLine(buf.text, "untracked  new.txt")
  await editor.handleKey({ name: "s", sequence: "s" })

  expect((await git(["diff", "--cached", "--name-only"])).trim()).toBe("new.txt")
  expect(editor.currentBuffer.text).toContain("Staged changes (1)")
  expect(editor.currentBuffer.text).toContain("new file   new.txt")
})

test("entryAtPoint resolves from inside a diff hunk", async () => {
  const editor = ed()
  await writeFile(join(repo, "a.txt"), "one\nchanged\n")
  await editor.run("magit-status", [repo])
  const buf = editor.currentBuffer
  buf.point = pointAtLine(buf.text, "+changed")
  const entry = entryAtPoint(buf)
  expect(entry?.file).toBe("a.txt")
  expect(entry?.staged).toBe(false)
})

test("s on a non-file line messages and does nothing", async () => {
  const editor = ed()
  await writeFile(join(repo, "a.txt"), "one\nchanged\n")
  await editor.run("magit-status", [repo])
  let last = ""
  editor.events.on("message", ({ text }) => { last = text })
  editor.currentBuffer.point = 0
  await editor.handleKey({ name: "s", sequence: "s" })
  expect(last).toContain("Nothing to stage")
  expect((await git(["diff", "--cached", "--name-only"])).trim()).toBe("")
})

test("g refreshes the buffer to pick up new worktree changes", async () => {
  const editor = ed()
  await editor.run("magit-status", [repo])
  expect(editor.currentBuffer.text).not.toContain("Unstaged changes")

  await writeFile(join(repo, "b.txt"), "two\nmore\n")
  await editor.handleKey({ name: "g", sequence: "g" })
  expect(editor.currentBuffer.text).toContain("Unstaged changes (1)")
  expect(editor.currentBuffer.text).toContain("modified   b.txt")
})

test("c c then C-c C-c commits staged changes and returns to status", async () => {
  const editor = ed()
  await writeFile(join(repo, "a.txt"), "one\nchanged\n")
  await git(["add", "a.txt"])
  await editor.run("magit-status", [repo])

  await editor.handleKey({ name: "c", sequence: "c" })
  await editor.handleKey({ name: "c", sequence: "c" })
  let buf = editor.currentBuffer
  expect(buf.name).toBe("*COMMIT_EDITMSG*")
  expect(buf.mode).toBe("magit-commit")
  expect(buf.locals.get("magit-root")).toBe(repo)

  buf.insert("second commit\n")
  await editor.handleKey({ name: "c", ctrl: true })
  await editor.handleKey({ name: "c", ctrl: true })

  buf = editor.currentBuffer
  expect(buf.mode).toBe("magit-status")
  expect(buf.text).not.toContain("Staged changes")
  expect(buf.text).toMatch(/[0-9a-f]{7} second commit/)
  const log = await git(["log", "--pretty=%s"])
  expect(log.split("\n").filter(Boolean)).toEqual(["second commit", "initial"])
  const stillOpen = [...editor.buffers.values()].some(b => b.name === "*COMMIT_EDITMSG*")
  expect(stillOpen).toBe(false)
})

test("C-c C-c with empty message aborts", async () => {
  const editor = ed()
  await writeFile(join(repo, "a.txt"), "one\nchanged\n")
  await git(["add", "a.txt"])
  await editor.run("magit-status", [repo])
  await editor.run("magit-commit")
  let last = ""
  editor.events.on("message", ({ text }) => { last = text })
  await editor.run("magit-commit-finish")
  expect(last).toContain("empty message")
  expect((await git(["log", "--pretty=%s"])).trim()).toBe("initial")
})

test("q buries the status buffer", async () => {
  const editor = ed()
  await editor.openFile(join(repo, "a.txt"))
  await editor.run("magit-status", [repo])
  expect(editor.currentBuffer.mode).toBe("magit-status")
  await editor.handleKey({ name: "q", sequence: "q" })
  expect(editor.currentBuffer.mode).not.toBe("magit-status")
})

test("entries cover both staged and unstaged for the same file", async () => {
  await writeFile(join(repo, "a.txt"), "staged-change\n")
  await git(["add", "a.txt"])
  await writeFile(join(repo, "a.txt"), "staged-change\nunstaged-change\n")
  const s = await buildStatus(repo)
  const files = s.entries.map((e: MagitEntry) => `${e.staged ? "S" : "U"}:${e.file}`)
  expect(files).toContain("U:a.txt")
  expect(files).toContain("S:a.txt")
  expect(s.text).toContain("Unstaged changes (1)")
  expect(s.text).toContain("Staged changes (1)")
})
