import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnProcess } from "../../src/platform/runtime"
import { makeEditor } from "./helper"
import {
  appendProcessEntry,
  createWithEditorSession,
  gitCommitFontLock,
  install,
  magitGitFailureDetail,
  magitCommitFixupArgs,
  magitCommitRewordArgs,
  magitCommitSquashArgs,
  magitRebaseInteractiveArgs,
  renderProcessEntries,
  openWithEditorBuffer,
} from "../../plugins/magit"

const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

test("with-editor helper reports the target file and exits ok after reply", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-with-editor-test-"))
  temps.push(dir)
  const target = join(dir, "COMMIT_EDITMSG")
  await writeFile(target, "subject\n")

  const session = await createWithEditorSession({ onRequest: () => {} })
  try {
    const proc = spawnProcess({
      cmd: [session.helperPath, target],
      env: { JEMACS_WITH_EDITOR_TIMEOUT_MS: "2000" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const request = await session.firstRequest
    expect(request.filePath).toBe(target)
    await writeFile(request.replyPath, "ok\n")
    expect(await proc.exited).toBe(0)
  } finally {
    await session.dispose()
  }
})

test("commit editor inserts an editable line before a byte-zero Git comment template", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-with-editor-template-"))
  temps.push(dir)
  const target = join(dir, "COMMIT_EDITMSG")
  await writeFile(target, "# Please enter the commit message\n# Changes to be committed:\n")
  const editor = makeEditor()

  const buffer = await openWithEditorBuffer(editor, {
    id: "request-test",
    filePath: target,
    replyPath: join(dir, "reply"),
  }, { root: dir })

  expect(buffer.text).toStartWith("\n# Please enter")
  expect(buffer.point).toBe(0)
  buffer.insert("subject")
  expect(buffer.text).toStartWith("subject\n# Please enter")
})

test("Magit failure detail includes stdout before falling back to a numeric exit code", () => {
  expect(magitGitFailureDetail({ out: "nothing added to commit\n", err: "", code: 1 })).toBe("nothing added to commit")
  expect(magitGitFailureDetail({ out: "", err: "hook rejected commit\n", code: 1 })).toBe("hook rejected commit")
  expect(magitGitFailureDetail({ out: "", err: "", code: 1 })).toBe("1")
})

test("commit and rebase argv builders match editor-backed Magit flows", () => {
  expect(magitCommitRewordArgs()).toEqual(["commit", "--amend", "--only"])
  expect(magitCommitFixupArgs("abc1234")).toEqual(["commit", "--fixup=abc1234"])
  expect(magitCommitSquashArgs("def5678")).toEqual(["commit", "--squash=def5678"])
  expect(magitRebaseInteractiveArgs("HEAD~5")).toEqual(["rebase", "-i", "--autosquash", "HEAD~5"])
  expect(() => magitCommitFixupArgs("--bad")).toThrow("invalid ref/remote name")
})

test("git commit font lock warns on long first message line after template comments", () => {
  const editor = makeEditor()
  const text = "\n" + "x".repeat(55) + "\n# comment\n"
  const buffer = editor.scratch("*COMMIT_EDITMSG*", text, "magit-commit")
  const spans = gitCommitFontLock(buffer)
  expect(spans).toContainEqual({ start: 1 + 50, end: 1 + 55, face: "warning" })
  expect(spans).toContainEqual({ start: 57, end: 66, face: "comment" })
})

test("magit process buffer renders each invocation as a section", () => {
  const rendered = renderProcessEntries([
    { args: ["status", "--short"], cwd: "/repo", out: " M a.txt\n", err: "", code: 0 },
    { args: ["commit"], cwd: "/repo", out: "", err: "empty message\n", code: 1 },
  ])
  expect(rendered.text).toContain("$ git status --short")
  expect(rendered.text).toContain(" M a.txt")
  expect(rendered.text).toContain("[exit 0]")
  expect(rendered.text).toContain("$ git commit")
  expect(rendered.root.children[0]?.children).toHaveLength(2)
  expect(rendered.root.children[0]?.children[0]?.type).toBe("process")
})

test("$ opens the section-backed magit process buffer", async () => {
  const editor = makeEditor()
  install(editor)
  const status = editor.scratch("*magit: repo*", "Head:     main\n", "magit-status")
  status.locals.set("magit-root", "/repo")
  appendProcessEntry(editor, { args: ["status"], cwd: "/repo", out: "clean\n", err: "", code: 0 })
  editor.switchToBuffer(status.id)

  await editor.handleKey({ name: "$", sequence: "$" })

  expect(editor.currentBuffer.name).toBe("*magit-process*")
  expect(editor.currentBuffer.mode).toBe("magit-process-mode")
  expect(editor.currentBuffer.text).toContain("$ git status")
  expect(editor.currentBuffer.text).toContain("clean")
})
