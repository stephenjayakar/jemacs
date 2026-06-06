import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeEditor } from "./helper"
import { keySeq } from "../harness"
import { spawnProcess } from "../../src/platform/runtime"
import { getMode } from "../../src/modes/mode"
import { install } from "../../plugins/magit"

let repo: string

async function git(args: string[], cwd = repo): Promise<string> {
  const proc = spawnProcess({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" })
  const out = proc.stdout ? await new Response(proc.stdout).text() : ""
  await proc.exited
  return out
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "jemacs-magit-parity-"))
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

function ed() {
  const editor = makeEditor()
  install(editor)
  return editor
}

test("install registers parity commands and bindings", () => {
  const editor = ed()
  for (const cmd of [
    "magit-merge", "magit-merge-abort", "magit-rebase", "magit-rebase-continue",
    "magit-rebase-abort", "magit-rebase-skip", "magit-cherry-pick", "magit-revert",
    "magit-tag", "magit-tag-delete", "magit-remote-add", "magit-remote-remove",
    "magit-remote-rename", "magit-branch-delete", "magit-branch-rename",
    "magit-stash-apply", "magit-stash-drop", "magit-stash-list",
    "magit-commit-extend", "magit-commit-reword",
    "magit-diff-working", "magit-diff-unstaged", "magit-diff-staged",
  ]) {
    expect(editor.commands.get(cmd)).toBeDefined()
  }
  const status = getMode("magit-status")
  expect(status?.keymap?.get("m m")).toBe("magit-merge")
  expect(status?.keymap?.get("r e")).toBe("magit-rebase")
  expect(status?.keymap?.get("r a")).toBe("magit-rebase-abort")
  expect(status?.keymap?.get("S-a a")).toBe("magit-cherry-pick")
  expect(status?.keymap?.get("S-v v")).toBe("magit-revert")
  expect(status?.keymap?.get("t t")).toBe("magit-tag")
  expect(status?.keymap?.get("S-m a")).toBe("magit-remote-add")
  expect(status?.keymap?.get("b k")).toBe("magit-branch-delete")
  expect(status?.keymap?.get("b m")).toBe("magit-branch-rename")
  expect(status?.keymap?.get("z a")).toBe("magit-stash-apply")
  expect(status?.keymap?.get("c e")).toBe("magit-commit-extend")
  expect(status?.keymap?.get("d d")).toBe("magit-diff-working")
  expect(status?.keymap?.get("n")).toBe("next-line")
  expect(status?.keymap?.get("p")).toBe("previous-line")
})

test("m m merges a branch into the current branch", async () => {
  // Create a divergent commit on a feature branch.
  await git(["checkout", "-q", "-b", "feature"])
  await writeFile(join(repo, "c.txt"), "feature\n")
  await git(["add", "."])
  await git(["commit", "-q", "-m", "feature commit"])
  await git(["checkout", "-q", "main"])

  const editor = ed()
  await editor.run("magit-status", [repo])
  editor.completingRead = () => Promise.resolve("feature")
  await keySeq(editor, "m", "m")

  expect((await git(["log", "--pretty=%s"])).split("\n")).toContain("feature commit")
})

test("t t creates a tag at HEAD; t k deletes it", async () => {
  const editor = ed()
  await editor.run("magit-status", [repo])
  editor.prompt = async () => "v1.0"
  await keySeq(editor, "t", "t")
  expect((await git(["tag", "--list"])).trim()).toBe("v1.0")

  editor.completingRead = () => Promise.resolve("v1.0")
  await keySeq(editor, "t", "k")
  expect((await git(["tag", "--list"])).trim()).toBe("")
})

test("b k deletes a branch", async () => {
  await git(["branch", "throwaway"])
  const editor = ed()
  await editor.run("magit-status", [repo])
  editor.completingRead = () => Promise.resolve("throwaway")
  await keySeq(editor, "b", "k")
  expect((await git(["branch", "--list", "throwaway"])).trim()).toBe("")
})

test("b m renames a branch", async () => {
  const editor = ed()
  await editor.run("magit-status", [repo])
  const replies = ["main", "trunk"]
  editor.completingRead = () => Promise.resolve(replies.shift()!)
  editor.prompt = async () => "trunk"
  await keySeq(editor, "b", "m")
  expect((await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe("trunk")
})

test("M a adds a remote; M k removes it", async () => {
  const editor = ed()
  await editor.run("magit-status", [repo])
  const replies = ["upstream", "https://example.com/x.git"]
  editor.prompt = async () => replies.shift()!
  await keySeq(editor, "S-m", "a")
  expect((await git(["remote"])).trim()).toBe("upstream")

  editor.completingRead = () => Promise.resolve("upstream")
  await keySeq(editor, "S-m", "k")
  expect((await git(["remote"])).trim()).toBe("")
})

test("c e extends HEAD with staged changes, keeping the message", async () => {
  await writeFile(join(repo, "a.txt"), "one\ntwo\n")
  await git(["add", "a.txt"])
  const editor = ed()
  await editor.run("magit-status", [repo])
  await keySeq(editor, "c", "e")

  expect((await git(["log", "--pretty=%s"])).trim()).toBe("initial")
  expect((await git(["show", "--stat", "--pretty=%s", "HEAD"]))).toContain("a.txt")
  expect((await git(["diff", "--cached", "--name-only"])).trim()).toBe("")
})

test("V v reverts the commit at point", async () => {
  await writeFile(join(repo, "a.txt"), "one\ntwo\n")
  await git(["commit", "-aqm", "second"])
  const head = (await git(["rev-parse", "HEAD"])).trim()

  const editor = ed()
  await editor.run("magit-status", [repo])
  await editor.run("magit-revert", [head])

  expect((await git(["log", "--pretty=%s"])).split("\n")[0]).toContain("Revert")
})

test("z a applies a stash without dropping it; z k drops it", async () => {
  await writeFile(join(repo, "a.txt"), "one\nstashed\n")
  await git(["stash", "push", "-q"])
  const editor = ed()
  await editor.run("magit-status", [repo])

  await keySeq(editor, "z", "a")
  expect((await git(["stash", "list"])).trim()).toContain("stash@{0}")
  expect(editor.currentBuffer.text).toContain("Unstaged changes")

  // reset working tree so drop is clean
  await git(["checkout", "--", "a.txt"])
  editor.prompt = async () => "y"
  await keySeq(editor, "z", "k")
  expect((await git(["stash", "list"])).trim()).toBe("")
})

test("d s opens a staged-diff buffer", async () => {
  await writeFile(join(repo, "a.txt"), "one\ntwo\n")
  await git(["add", "a.txt"])
  const editor = ed()
  await editor.run("magit-status", [repo])
  await keySeq(editor, "d", "s")
  const buf = editor.currentBuffer
  expect(buf.name).toBe("*magit-diff: staged*")
  expect(buf.readOnly).toBe(true)
  expect(buf.text).toContain("+two")
})
