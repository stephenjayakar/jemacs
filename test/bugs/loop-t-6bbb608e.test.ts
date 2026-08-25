import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeEditor } from "../plugins/helper"
import { spawnProcess } from "../../src/platform/runtime"
import { listWindowLeaves } from "../../src/kernel/window"
import { install } from "../../plugins/magit"
import { keySeq } from "../harness/script"

let repo: string

async function git(args: string[]): Promise<string> {
  const proc = spawnProcess({ cmd: ["git", ...args], cwd: repo, stdout: "pipe", stderr: "pipe" })
  const out = proc.stdout ? await new Response(proc.stdout).text() : ""
  await proc.exited
  return out
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "jemacs-magit-t6bbb-"))
  await git(["init", "-q", "-b", "main"])
  await git(["config", "user.email", "test@example.com"])
  await git(["config", "user.name", "test"])
  await writeFile(join(repo, "a.txt"), "one\n")
  await git(["add", "."])
  await git(["commit", "-q", "-m", "initial"])
})

afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

// t-6bbb608e: after c c → message → C-c C-c, refresh() reapplied the *stale*
// byte offset from the pre-commit status buffer, landing point mid-subject in
// Recent commits. Real magit returns to the top of the status buffer.
test("magit-commit-finish: refreshed status buffer has point at bob, not stale offset", async () => {
  const editor = makeEditor()
  install(editor)
  await writeFile(join(repo, "a.txt"), "one\nchanged\nmore lines\neven more\n")
  await git(["add", "a.txt"])
  await editor.run("magit-status", [repo])

  // User was sitting on the staged entry when they hit c c — that section is
  // about to vanish, so its byte offset is meaningless after commit.
  const status = editor.currentBuffer
  const stagedAt = status.text.indexOf("modified   a.txt")
  expect(stagedAt).toBeGreaterThan(0)
  status.point = stagedAt

  await editor.run("magit-commit")
  editor.currentBuffer.insert("second commit\n")
  await editor.run("magit-commit-finish")

  const buf = editor.currentBuffer
  expect(buf.mode).toBe("magit-status")
  expect(buf.text).not.toContain("Staged changes")
  expect(buf.text).toMatch(/[0-9a-f]{7} second commit/)
  expect(buf.point).toBe(0)
})

// t-6bbb608e secondary: COMMIT_EDITMSG should show the staged diff in a split,
// like real magit, so the user can see what they're committing.
test("magit-commit: shows staged diff in a split window alongside COMMIT_EDITMSG", async () => {
  const editor = makeEditor()
  install(editor)
  await writeFile(join(repo, "a.txt"), "one\nchanged\n")
  await git(["add", "a.txt"])
  await editor.run("magit-status", [repo])

  await editor.run("magit-commit")

  expect(editor.currentBuffer.name).toBe("*COMMIT_EDITMSG*")
  expect(editor.currentBuffer.text).toStartWith("\n# Please enter")
  expect(editor.currentBuffer.point).toBe(0)
  const leaves = listWindowLeaves(editor.windowLayout)
  expect(leaves.length).toBeGreaterThanOrEqual(2)
  const diffBuf = [...editor.buffers.values()].find(b => b.name === "*magit-diff: staged*")
  expect(diffBuf).toBeDefined()
  expect(diffBuf!.mode).toBe("magit-diff-mode")
  expect(diffBuf!.readOnly).toBe(true)
  expect(diffBuf!.text).toContain("+changed")
  expect(leaves.some(l => l.bufferId === diffBuf!.id)).toBe(true)

  editor.currentBuffer.insert("second\n")
  await editor.run("magit-commit-finish")

  // Diff buffer is cleaned up and we're back in a single-window status view.
  expect(editor.currentBuffer.mode).toBe("magit-status")
  expect([...editor.buffers.values()].some(b => b.name === "*magit-diff: staged*")).toBe(false)
  expect(listWindowLeaves(editor.windowLayout).length).toBe(1)
})

test("magit status c c opens COMMIT_EDITMSG and C-c C-c commits it", async () => {
  const editor = makeEditor()
  install(editor)
  await writeFile(join(repo, "a.txt"), "one\nchanged through transient\n")
  await git(["add", "a.txt"])
  await editor.run("magit-status", [repo])

  await keySeq(editor, "c", "c")
  expect(editor.currentBuffer.name).toBe("*COMMIT_EDITMSG*")
  expect(editor.currentBuffer.mode).toBe("magit-commit")

  editor.currentBuffer.insert("transient commit\n")
  await keySeq(editor, "C-c", "C-c")

  expect(editor.currentBuffer.mode).toBe("magit-status")
  expect(await git(["log", "-1", "--pretty=%s"])).toBe("transient commit\n")
})

test("magit commit explains that unstaged changes must be staged first", async () => {
  const editor = makeEditor()
  install(editor)
  await writeFile(join(repo, "a.txt"), "one\nchanged but unstaged\n")
  await editor.run("magit-status", [repo])
  const seen: string[] = []
  editor.events.on("message", ({ text }) => { if (text) seen.push(text) })

  await editor.run("magit-commit")

  expect(editor.currentBuffer.mode).toBe("magit-status")
  expect(seen.at(-1)).toBe("Nothing staged; stage changes with s before committing")
})
