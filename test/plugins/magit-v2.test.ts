import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeEditor } from "./helper"
import { keySeq } from "../harness"
import { spawnProcess } from "../../src/platform/runtime"
import { getMode } from "../../src/modes/mode"
import { install, logShaAtPoint, entryAtPoint, magitDiffFontLock } from "../../plugins/magit"
import { listWindowLeaves } from "../../src/kernel/window"

let repo: string
let remote: string

async function git(args: string[], cwd = repo): Promise<string> {
  const proc = spawnProcess({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" })
  const out = proc.stdout ? await new Response(proc.stdout).text() : ""
  await proc.exited
  return out
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "jemacs-magit-v2-"))
  remote = await mkdtemp(join(tmpdir(), "jemacs-magit-v2-remote-"))
  await git(["init", "-q", "--bare"], remote)
  await git(["init", "-q", "-b", "main"])
  await git(["config", "user.email", "test@example.com"])
  await git(["config", "user.name", "test"])
  await writeFile(join(repo, "a.txt"), "one\n")
  await writeFile(join(repo, "b.txt"), "two\n")
  await git(["add", "."])
  await git(["commit", "-q", "-m", "initial"])
  await git(["remote", "add", "origin", remote])
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
  await rm(remote, { recursive: true, force: true })
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

test("install registers v2 commands, modes and bindings", () => {
  const editor = ed()
  for (const cmd of [
    "magit-push", "magit-log", "magit-log-show-commit", "magit-branch-checkout",
    "magit-branch-create", "magit-stash", "magit-stash-pop", "magit-discard",
    "magit-reset", "magit-toggle-fold", "magit-commit-abort",
  ]) {
    expect(editor.commands.get(cmd)).toBeDefined()
  }
  const status = getMode("magit-status")
  expect(status?.keymap?.get("S-p p")).toBe("magit-push")
  expect(status?.keymap?.get("l l")).toBe("magit-log")
  expect(status?.keymap?.get("b b")).toBe("magit-branch-checkout")
  expect(status?.keymap?.get("b c")).toBe("magit-branch-create")
  expect(status?.keymap?.get("z z")).toBe("magit-stash")
  expect(status?.keymap?.get("z p")).toBe("magit-stash-pop")
  expect(status?.keymap?.get("k")).toBe("magit-discard")
  expect(status?.keymap?.get("x")).toBe("magit-reset")
  expect(status?.keymap?.get("tab")).toBe("magit-section-toggle")

  expect(getMode("magit-commit")?.keymap?.get("C-c C-k")).toBe("magit-commit-abort")

  const log = getMode("magit-log")
  expect(log).toBeDefined()
  expect(log?.keymap?.get("return")).toBe("magit-log-show-commit")
  expect(log?.keymap?.get("q")).toBe("magit-bury-buffer")

  expect(getMode("magit-status")?.fontLock).toBe(magitDiffFontLock)
  expect(getMode("magit-log")?.fontLock).toBe(magitDiffFontLock)
  const revision = getMode("magit-revision")
  expect(revision?.parent).toBe("magit-special")
  expect(revision?.fontLock).toBe(magitDiffFontLock)
  expect(revision?.keymap?.get("q")).toBe("magit-bury-buffer")
})

test("magitDiffFontLock colors @@/+/- and section headers", () => {
  const text = [
    "Head:     main initial",
    "",
    "Unstaged changes (1)",
    "modified   a.txt",
    "@@ -1 +1,2 @@",
    " one",
    "+two",
    "-three",
    "",
    "Recent commits",
    "abc1234 initial",
  ].join("\n")
  const spans = magitDiffFontLock({ text } as never)
  const faceAt = (needle: string) => spans.find(s => s.start === text.indexOf(needle))?.face
  expect(faceAt("Head:")).toBe("keyword")
  expect(faceAt("Unstaged changes")).toBe("keyword")
  expect(faceAt("Recent commits")).toBe("keyword")
  expect(faceAt("@@ -1")).toBe("builtin")
  expect(faceAt("+two")).toBe("string")
  expect(faceAt("-three")).toBe("error")
  expect(faceAt("modified   a.txt")).toBeUndefined()
  expect(faceAt(" one")).toBeUndefined()
})

test("magit-status buffer reaches diff font-lock through editor.fontLock", async () => {
  const editor = ed()
  await writeFile(join(repo, "a.txt"), "one\ntwo\n")
  await editor.run("magit-status", [repo])
  const buf = editor.currentBuffer
  const spans = editor.fontLock(buf)
  const added = buf.text.indexOf("+two")
  expect(spans.some(s => s.start === added && s.face === "string")).toBe(true)
  const hunk = buf.text.indexOf("@@")
  expect(spans.some(s => s.start === hunk && s.face === "builtin")).toBe(true)
})

test("P p pushes to a bare remote with prompted defaults (origin, current branch)", async () => {
  const editor = ed()
  await editor.run("magit-status", [repo])
  const prompts: Array<{ prompt: string; initial: string }> = []
  editor.prompt = async (prompt, initial = "") => {
    prompts.push({ prompt, initial })
    return initial
  }
  await keySeq(editor, "S-p", "p")

  expect(prompts[0]).toEqual({ prompt: "Push to remote: ", initial: "origin" })
  expect(prompts[1]).toEqual({ prompt: "Push branch: ", initial: "main" })
  const remoteLog = await git(["log", "--pretty=%s", "main"], remote)
  expect(remoteLog.trim()).toBe("initial")
})

test("l l opens *magit-log* in magit-log mode; RET shows the commit", async () => {
  const editor = ed()
  await writeFile(join(repo, "a.txt"), "one\nmore\n")
  await git(["commit", "-aqm", "second"])
  await editor.run("magit-status", [repo])
  await keySeq(editor, "l", "l")

  let buf = editor.currentBuffer
  expect(buf.name).toBe("*magit-log*")
  expect(buf.mode).toBe("magit-log")
  expect(buf.readOnly).toBe(true)
  expect(buf.locals.get("magit-root")).toBe(repo)
  expect(buf.text).toMatch(/\* [0-9a-f]{7} second/)
  expect(buf.text).toMatch(/\* [0-9a-f]{7} initial/)

  buf.point = pointAtLine(buf.text, "initial")
  const sha = logShaAtPoint(buf)
  expect(sha).toMatch(/^[0-9a-f]{7,}$/)

  await editor.handleKey({ name: "return" })
  // RET opens the revision in a split below and keeps the log selected (t-e6d604ba).
  expect(editor.currentBuffer.name).toBe("*magit-log*")
  expect(listWindowLeaves(editor.windowLayout)).toHaveLength(2)
  const rev = [...editor.buffers.values()].find(b => b.name === `*magit-commit: ${sha}*`)!
  expect(rev.mode).toBe("magit-revision")
  expect(rev.readOnly).toBe(true)
  expect(rev.text).toContain("initial")
  expect(rev.text).toContain("a.txt")
})

test("b c creates and checks out; b b checks out an existing branch", async () => {
  const editor = ed()
  await editor.run("magit-status", [repo])

  editor.prompt = async () => "feature"
  await keySeq(editor, "b", "c")
  expect((await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("feature")
  expect(editor.currentBuffer.text).toContain("Head:     feature")

  let seen: string[] | undefined
  editor.completingRead = (_prompt, opts) => {
    seen = opts.collection
    return Promise.resolve("main")
  }
  await keySeq(editor, "b", "b")
  expect(seen).toContain("main")
  expect(seen).toContain("feature")
  expect((await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("main")
  expect(editor.currentBuffer.text).toContain("Head:     main")
})

test("z z stashes worktree changes; z p pops them back", async () => {
  const editor = ed()
  await writeFile(join(repo, "a.txt"), "one\nstashed\n")
  await editor.run("magit-status", [repo])
  expect(editor.currentBuffer.text).toContain("Unstaged changes (1)")

  await keySeq(editor, "z", "z")
  expect((await git(["stash", "list"])).trim()).toContain("stash@{0}")
  expect(editor.currentBuffer.text).not.toContain("Unstaged changes")
  expect((await readFile(join(repo, "a.txt"), "utf8"))).toBe("one\n")

  await keySeq(editor, "z", "p")
  expect((await git(["stash", "list"])).trim()).toBe("")
  expect(editor.currentBuffer.text).toContain("Unstaged changes (1)")
  expect((await readFile(join(repo, "a.txt"), "utf8"))).toBe("one\nstashed\n")
})

test("k discards unstaged changes after confirming y; n leaves them", async () => {
  const editor = ed()
  await writeFile(join(repo, "a.txt"), "one\nchanged\n")
  await editor.run("magit-status", [repo])
  let buf = editor.currentBuffer
  buf.point = pointAtLine(buf.text, "modified   a.txt")

  let asked = ""
  editor.prompt = async p => { asked = p; return "n" }
  await editor.run("magit-discard")
  expect(asked).toContain("Discard changes in a.txt?")
  expect((await readFile(join(repo, "a.txt"), "utf8"))).toBe("one\nchanged\n")

  editor.prompt = async () => "y"
  buf = editor.currentBuffer
  buf.point = pointAtLine(buf.text, "modified   a.txt")
  await editor.run("magit-discard")
  expect((await readFile(join(repo, "a.txt"), "utf8"))).toBe("one\n")
  expect(editor.currentBuffer.text).not.toContain("Unstaged changes")
})

test("x resets the index, moving staged back to unstaged", async () => {
  const editor = ed()
  await writeFile(join(repo, "a.txt"), "one\nchanged\n")
  await git(["add", "a.txt"])
  await editor.run("magit-status", [repo])
  expect(editor.currentBuffer.text).toContain("Staged changes (1)")

  await keySeq(editor, "x")
  expect((await git(["diff", "--cached", "--name-only"])).trim()).toBe("")
  expect(editor.currentBuffer.text).not.toContain("Staged changes")
  expect(editor.currentBuffer.text).toContain("Unstaged changes (1)")
})

test("tab folds the diff body for the entry at point and toggles back", async () => {
  const editor = ed()
  await writeFile(join(repo, "a.txt"), "one\nchanged\n")
  await editor.run("magit-status", [repo])
  let buf = editor.currentBuffer
  expect(buf.text).toContain("@@")
  expect(buf.text).toContain("+changed")

  buf.point = pointAtLine(buf.text, "modified   a.txt")
  await editor.handleKey({ name: "tab" })
  buf = editor.currentBuffer
  expect(buf.text).toContain("modified   a.txt")
  expect(buf.text).not.toContain("@@")
  expect(buf.text).not.toContain("+changed")
  expect(entryAtPoint(buf)?.file).toBe("a.txt")
  expect((buf.locals.get("magit-folded") as Set<string>).has("U:a.txt")).toBe(true)

  await editor.handleKey({ name: "tab" })
  buf = editor.currentBuffer
  expect(buf.text).toContain("@@")
  expect(buf.text).toContain("+changed")
  expect((buf.locals.get("magit-folded") as Set<string>).size).toBe(0)
})

test("fold state survives g refresh", async () => {
  const editor = ed()
  await writeFile(join(repo, "a.txt"), "one\nchanged\n")
  await editor.run("magit-status", [repo])
  let buf = editor.currentBuffer
  buf.point = pointAtLine(buf.text, "modified   a.txt")
  await editor.handleKey({ name: "tab" })
  expect(editor.currentBuffer.text).not.toContain("@@")

  await keySeq(editor, "g")
  expect(editor.currentBuffer.text).toContain("modified   a.txt")
  expect(editor.currentBuffer.text).not.toContain("@@")
})

test("C-c C-k aborts the commit message buffer without committing", async () => {
  const editor = ed()
  await writeFile(join(repo, "a.txt"), "one\nchanged\n")
  await git(["add", "a.txt"])
  await editor.run("magit-status", [repo])

  await keySeq(editor, "c", "c")
  expect(editor.currentBuffer.name).toBe("*COMMIT_EDITMSG*")
  editor.currentBuffer.insert("never landed\n")

  await keySeq(editor, "C-c", "C-k")
  expect(editor.currentBuffer.mode).toBe("magit-status")
  const stillOpen = [...editor.buffers.values()].some(b => b.name === "*COMMIT_EDITMSG*")
  expect(stillOpen).toBe(false)
  expect((await git(["log", "--pretty=%s"])).trim()).toBe("initial")
  expect((await git(["diff", "--cached", "--name-only"])).trim()).toBe("a.txt")
})
