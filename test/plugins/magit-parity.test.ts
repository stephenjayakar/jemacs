import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeEditor } from "./helper"
import { keySeq } from "../harness"
import { spawnProcess } from "../../src/platform/runtime"
import { getMode } from "../../src/modes/mode"
import { buildStatus, install } from "../../plugins/magit"

let repo: string
let extraPaths: string[] = []

async function git(args: string[], cwd = repo): Promise<string> {
  const proc = spawnProcess({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" })
  const out = proc.stdout ? await new Response(proc.stdout).text() : ""
  await proc.exited
  return out
}

beforeEach(async () => {
  extraPaths = []
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
  await Promise.all(extraPaths.map(path => rm(path, { recursive: true, force: true })))
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

async function bareRemote(name: string): Promise<string> {
  const remote = await mkdtemp(join(tmpdir(), `jemacs-magit-${name}-`))
  extraPaths.push(remote)
  await git(["init", "--bare", "-q", "-b", "main", remote])
  return remote
}

async function commitToRemote(remote: string, file: string, message: string): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), "jemacs-magit-remote-work-"))
  extraPaths.push(work)
  await git(["clone", "-q", remote, work])
  await git(["config", "user.email", "test@example.com"], work)
  await git(["config", "user.name", "test"], work)
  await writeFile(join(work, file), `${message}\n`)
  await git(["add", "."], work)
  await git(["commit", "-q", "-m", message], work)
  await git(["push", "-q", "origin", "main"], work)
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
    "magit-file-popup", "magit-file-untrack", "magit-stage-intent-to-add",
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
  expect(status?.keymap?.get("S-x")).toBe("magit-file-popup")
  expect(status?.keymap?.get("n")).toBe("magit-section-forward")
  expect(status?.keymap?.get("p")).toBe("magit-section-backward")
})

test("status headers show upstream pull mode, push target, and described tag", async () => {
  const origin = await bareRemote("origin")
  const publish = await bareRemote("publish")
  await git(["remote", "add", "origin", origin])
  await git(["remote", "add", "publish", publish])
  await git(["push", "-q", "-u", "origin", "main"])
  await git(["push", "-q", "publish", "main"])
  await git(["fetch", "-q", "origin"])
  await git(["fetch", "-q", "publish"])
  await git(["config", "branch.main.pushRemote", "publish"])
  await git(["config", "pull.rebase", "true"])
  await git(["tag", "v1.0"])

  const status = await buildStatus(repo)

  expect(status.text).toContain("Head:     main initial")
  expect(status.text).toContain("Rebase:   origin/main initial")
  expect(status.text).toContain("Push:     publish/main initial")
  expect(status.text).toContain("Tag:      v1.0 (0)")
  expect(status.text).not.toContain("Merge:    origin/main")
})

test("status shows unpushed and unpulled sections for upstream and push-remote", async () => {
  const origin = await bareRemote("origin")
  const publish = await bareRemote("publish")
  await git(["remote", "add", "origin", origin])
  await git(["remote", "add", "publish", publish])
  await git(["push", "-q", "-u", "origin", "main"])
  await git(["push", "-q", "publish", "main"])
  await git(["config", "branch.main.pushRemote", "publish"])

  await commitToRemote(origin, "origin.txt", "origin ahead")
  await commitToRemote(publish, "publish.txt", "publish ahead")
  await writeFile(join(repo, "local.txt"), "local ahead\n")
  await git(["add", "."])
  await git(["commit", "-q", "-m", "local ahead"])
  await git(["fetch", "-q", "origin"])
  await git(["fetch", "-q", "publish"])

  const status = await buildStatus(repo)

  expect(status.text).toContain("Unpushed to origin/main")
  expect(status.text).toContain("Unpulled from origin/main")
  expect(status.text).toContain("Unpushed to publish/main")
  expect(status.text).toContain("Unpulled from publish/main")
  expect(status.text).toContain("local ahead")
  expect(status.text).toContain("origin ahead")
  expect(status.text).toContain("publish ahead")
})

test("merge conflict status shows in-progress merge and conflicted files", async () => {
  await git(["checkout", "-q", "-b", "feature"])
  await writeFile(join(repo, "a.txt"), "feature\n")
  await git(["commit", "-am", "feature edit", "-q"])
  await git(["checkout", "-q", "main"])
  await writeFile(join(repo, "a.txt"), "main\n")
  await git(["commit", "-am", "main edit", "-q"])
  await git(["merge", "feature"])

  const status = await buildStatus(repo)

  expect(status.text).toContain("Merging")
  expect(status.text).toContain("Conflicts (1)")
  expect(status.text).toContain("unmerged   a.txt")
})

test("rename entries display old and new paths and stage/unstage as a pair", async () => {
  await git(["mv", "a.txt", "renamed.txt"])
  const editor = ed()
  await editor.run("magit-status", [repo])
  let buf = editor.currentBuffer
  expect(buf.text).toContain("renamed   a.txt -> renamed.txt")

  buf.point = pointAtLine(buf.text, "renamed   a.txt -> renamed.txt")
  await keySeq(editor, "u")
  expect((await git(["diff", "--cached", "--name-status"])).trim()).toBe("")
  buf = editor.currentBuffer
  expect(buf.text).toContain("deleted")
  expect(buf.text).toContain("untracked  renamed.txt")

  buf.point = pointAtLine(buf.text, "deleted")
  await keySeq(editor, "s")
  buf = editor.currentBuffer
  buf.point = pointAtLine(buf.text, "untracked  renamed.txt")
  await keySeq(editor, "s")

  expect(editor.currentBuffer.text).toContain("renamed   a.txt -> renamed.txt")
  expect((await git(["diff", "--cached", "--name-status"]))).toContain("R100")
})

test("X u untracks a file and X i marks an untracked file intent-to-add", async () => {
  const editor = ed()
  await writeFile(join(repo, "a.txt"), "changed\n")
  await editor.run("magit-status", [repo])
  let buf = editor.currentBuffer
  buf.point = pointAtLine(buf.text, "modified   a.txt")
  await keySeq(editor, "S-x", "u")
  expect((await git(["ls-files", "--", "a.txt"])).trim()).toBe("")
  expect(editor.currentBuffer.text).toContain("untracked  a.txt")

  await git(["add", "a.txt"])
  await git(["commit", "-q", "-m", "track a again"])
  await writeFile(join(repo, "intent.txt"), "intent\n")
  await editor.run("magit-status", [repo])
  buf = editor.currentBuffer
  buf.point = pointAtLine(buf.text, "untracked  intent.txt")
  await keySeq(editor, "S-x", "i")

  expect((await git(["diff", "--cached", "--name-only"])).trim()).toBe("")
  expect((await git(["diff", "--name-only"]))).toContain("intent.txt")
  expect(editor.currentBuffer.text).toContain("new file   intent.txt")
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
  expect(editor.currentBuffer.name).toBe("*COMMIT_EDITMSG*")
  editor.currentBuffer.insert("release v1.0\n")
  await keySeq(editor, "C-c", "C-c")
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
  expect(editor.currentBuffer.name).toBe("*COMMIT_EDITMSG*")
  await keySeq(editor, "C-c", "C-c")

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
  expect(buf.mode).toBe("magit-diff-mode")
  expect(buf.readOnly).toBe(true)
  expect(buf.text).toContain("+two")
})
