import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeEditor } from "../plugins/helper"
import { spawnProcess } from "../../src/platform/runtime"
import { install } from "../../plugins/magit"

// t-26dfa2ae: magit binds 'P p' for push, which normalizeToken stores as 'p p',
// but a real terminal sends Shift+P as {name:'p', shift:true} → keyToken 'S-p',
// so the prefix never matches and dispatch falls through to self-insert on a
// readOnly buffer → "Buffer ... is read-only" with a full stack trace.
//
// t-e061bdb3 (merged): same fallthrough for *any* unbound printable in
// magit-status — real magit derives from special-mode where stray printables
// are no-ops, not self-insert.

let repo: string

async function git(args: string[]): Promise<void> {
  const proc = spawnProcess({ cmd: ["git", ...args], cwd: repo, stdout: "pipe", stderr: "pipe" })
  await proc.exited
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "jemacs-magit-t26dfa2ae-"))
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

test("t-26dfa2ae: Shift+P in magit-status is the push prefix, not a read-only throw", async () => {
  const editor = ed()
  await editor.run("magit-status", [repo])
  expect(editor.currentBuffer.mode).toBe("magit-status")
  expect(editor.currentBuffer.readOnly).toBe(true)

  const prompts: string[] = []
  editor.prompt = async (p) => { prompts.push(p); return null }

  // What OpenTUI actually delivers for Shift+P: lowercase name, uppercase
  // sequence, shift modifier set. keyToken() turns this into 'S-p'.
  const shiftP = { name: "p", sequence: "P", shift: true }
  const r1 = await editor.handleKey(shiftP)
  expect(r1.status).toBe("pending")

  await editor.handleKey({ name: "p", sequence: "p" })
  expect(prompts[0]).toBe("Push to remote: ")
})

test("t-e061bdb3: unbound printables in magit-status are swallowed, not self-inserted", async () => {
  const editor = ed()
  await editor.run("magit-status", [repo])
  const buf = editor.currentBuffer
  const before = buf.text

  // 'a' is not bound in magit-status; it must not reach self-insert → throw,
  // and it must not mutate the buffer.
  const ra = await editor.handleKey({ name: "a", sequence: "a" })
  expect(ra.status).toBe("command")
  expect(ra.status === "command" && ra.command).not.toBe("self-insert-command")
  expect(buf.text).toBe(before)

  // '3' (digit) — same expectation.
  await editor.handleKey({ name: "3", sequence: "3" })
  expect(buf.text).toBe(before)

  // Shift+D — future capital-letter bindings hit the same hazard.
  await editor.handleKey({ name: "d", sequence: "D", shift: true })
  expect(buf.text).toBe(before)
})
