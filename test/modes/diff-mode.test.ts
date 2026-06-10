import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BufferModel, inferMode } from "../../src/kernel/buffer"
import { getMode } from "../../src/modes/mode"
import { diffFileAtPoint, diffFontLock, diffHunkAtPoint, parseDiffBuffer } from "../../src/modes/diff"
import { makeEditor } from "../plugins/helper"
import { currentKill } from "../../src/runtime/kill-ring"

const sample = [
  "diff --git a/a.txt b/a.txt",
  "index 1111111..2222222 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,2 +1,3 @@ function name",
  " one",
  "-two",
  "+TWO",
  "+three",
  "",
  "diff --git a/b.txt b/b.txt",
  "--- a/b.txt",
  "+++ b/b.txt",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n")

test("diff-mode is installed as a core mode and inferred for patches", () => {
  const editor = makeEditor()
  const mode = getMode("diff-mode")
  expect(mode?.parent).toBe("text")
  expect(mode?.keymap?.get("n")).toBe("diff-hunk-next")
  expect(mode?.keymap?.get("C-c C-a")).toBe("diff-apply-hunk")
  expect(editor.commands.get("diff-hunk-next")).toBeDefined()
  expect(inferMode("change.patch")).toBe("diff-mode")
  expect(inferMode("change.diff")).toBe("diff-mode")
})

test("parseDiffBuffer tracks unified files and hunks", () => {
  const buffer = new BufferModel({ name: "x.diff", text: sample, mode: "diff-mode" })
  const files = parseDiffBuffer(buffer)
  expect(files).toHaveLength(2)
  expect(files[0]?.oldFile).toBe("a.txt")
  expect(files[0]?.newFile).toBe("a.txt")
  expect(files[0]?.hunks[0]).toMatchObject({ style: "unified", oldStart: 1, oldCount: 2, newStart: 1, newCount: 3 })
  expect(files[1]?.oldFile).toBe("b.txt")
  buffer.point = sample.indexOf("+TWO")
  expect(diffFileAtPoint(buffer)?.newFile).toBe("a.txt")
  expect(diffHunkAtPoint(buffer)?.newCount).toBe(3)
})

test("diffFontLock uses GNU-style diff faces", () => {
  const buffer = new BufferModel({ name: "x.diff", text: sample, mode: "diff-mode" })
  const spans = diffFontLock(buffer)
  const faceAt = (needle: string) => spans.find(s => s.start === sample.indexOf(needle))?.face
  expect(faceAt("diff --git")).toBe("diffHeader")
  expect(faceAt("index ")).toBe("diffIndex")
  expect(faceAt("--- a/a.txt")).toBe("diffFileHeader")
  expect(faceAt("@@ -1")).toBe("diffHunkHeader")
  expect(faceAt(" function name")).toBe("diffFunction")
  expect(faceAt("-two")).toBe("diffRemoved")
  expect(faceAt("+TWO")).toBe("diffAdded")
  expect(faceAt(" one")).toBe("diffContext")
})

test("navigation and deletion commands operate on hunks and files", async () => {
  const editor = makeEditor()
  const buffer = editor.scratch("*diff*", sample, "diff-mode")
  await editor.run("diff-hunk-next")
  expect(buffer.text.slice(buffer.point).startsWith("@@ -1,2")).toBe(true)
  await editor.run("diff-hunk-next")
  expect(buffer.text.slice(buffer.point).startsWith("@@ -1 +1")).toBe(true)
  await editor.run("diff-file-prev")
  expect(buffer.text.slice(buffer.point).startsWith("diff --git a/a.txt")).toBe(true)
  buffer.point = buffer.text.indexOf("@@ -1 +1")
  await editor.run("diff-hunk-kill")
  expect(buffer.text).not.toContain("+new")
  expect(buffer.text).toContain("+TWO")
})

test("diff-reverse-direction swaps headers, hunk ranges, and line polarity", async () => {
  const editor = makeEditor()
  const buffer = editor.scratch("*diff*", sample, "diff-mode")
  await editor.run("diff-reverse-direction")
  expect(buffer.text).toContain("diff --git a/a.txt b/a.txt")
  expect(buffer.text).toContain("--- b/a.txt")
  expect(buffer.text).toContain("+++ a/a.txt")
  expect(buffer.text).toContain("@@ -1,3 +1,2 @@ function name")
  expect(buffer.text).toContain("+two")
  expect(buffer.text).toContain("-TWO")
})

test("diff-apply-hunk applies the current hunk with git apply", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-diff-mode-"))
  try {
    await writeFile(join(dir, "a.txt"), "one\ntwo\n")
    const editor = makeEditor()
    const buffer = editor.scratch("*diff*", sample, "diff-mode")
    buffer.locals.set("diff-default-directory", dir)
    buffer.point = buffer.text.indexOf("@@ -1,2")
    await editor.run("diff-test-hunk")
    await editor.run("diff-apply-hunk")
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("one\nTWO\nthree\n")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("diff-split-hunk splits unified hunks and recomputes ranges", async () => {
  const editor = makeEditor()
  const buffer = editor.scratch("*diff*", sample, "diff-mode")
  buffer.point = buffer.text.indexOf("+TWO")
  await editor.run("diff-split-hunk")
  expect(buffer.text).toContain("@@ -1,2 +1 @@ function name")
  expect(buffer.text).toContain("@@ -3,0 +2,2 @@ function name")
  const files = parseDiffBuffer(buffer)
  expect(files[0]?.hunks).toHaveLength(2)
})

test("diff-restrict-view narrows display to hunk or file and widen clears it", async () => {
  const editor = makeEditor()
  const buffer = editor.scratch("*diff*", sample, "diff-mode")
  buffer.point = buffer.text.indexOf("+TWO")
  await editor.run("diff-restrict-view")
  const hunkFilter = getMode("diff-mode")?.displayFilter?.(buffer)
  expect(hunkFilter?.text).toContain("+TWO")
  expect(hunkFilter?.text).not.toContain("diff --git")
  await editor.run("widen")
  expect(getMode("diff-mode")?.displayFilter?.(buffer)).toBeNull()

  buffer.point = buffer.text.indexOf("+new")
  editor.prefixArg.addDigit(4)
  await editor.run("diff-restrict-view")
  const fileFilter = getMode("diff-mode")?.displayFilter?.(buffer)
  expect(fileFilter?.text).toContain("diff --git a/b.txt")
  expect(fileFilter?.text).toContain("+new")
  expect(fileFilter?.text).not.toContain("+TWO")
})

test("diff-kill-ring-save copies modified or original hunk text", async () => {
  const editor = makeEditor()
  const buffer = editor.scratch("*diff*", sample, "diff-mode")
  buffer.point = buffer.text.indexOf("+TWO")
  await editor.run("diff-kill-ring-save")
  expect(currentKill(editor)).toBe("one\nTWO\nthree\n")
  editor.prefixArg.addDigit(4)
  await editor.run("diff-kill-ring-save")
  expect(currentKill(editor)).toBe("one\ntwo\n")
})

test("diff-unified->context and diff-context->unified convert the current hunk", async () => {
  const editor = makeEditor()
  const buffer = editor.scratch("*diff*", sample, "diff-mode")
  buffer.point = buffer.text.indexOf("+TWO")
  await editor.run("diff-unified->context")
  expect(buffer.text).toContain("***************")
  expect(buffer.text).toContain("*** 1,2 ****")
  expect(buffer.text).toContain("--- 1,3 ----")
  expect(buffer.text).toContain("! TWO")

  buffer.point = buffer.text.indexOf("***************")
  await editor.run("diff-context->unified")
  expect(buffer.text).toContain("@@ -1,2 +1,3 @@")
  expect(buffer.text).toContain("-two")
  expect(buffer.text).toContain("+TWO")
  expect(buffer.text).toContain("+three")
})

test("diff-ignore-whitespace-hunk removes a whitespace-only hunk", async () => {
  const editor = makeEditor()
  const text = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-one ",
    "+one",
    "",
  ].join("\n")
  const buffer = editor.scratch("*diff*", text, "diff-mode")
  buffer.point = buffer.text.indexOf("@@")
  await editor.run("diff-ignore-whitespace-hunk")
  expect(buffer.text).not.toContain("@@ -1 +1 @@")
  expect(buffer.text).not.toContain("-one ")
  expect(buffer.text).not.toContain("+one")
})

test("diff-refine-hunk highlights changed substrings in unified hunks", async () => {
  const editor = makeEditor()
  const buffer = editor.scratch("*diff*", sample, "diff-mode")
  buffer.point = buffer.text.indexOf("+TWO")
  await editor.run("diff-refine-hunk")
  const spans = editor.fontLock(buffer)
  const removed = buffer.text.indexOf("two")
  const added = buffer.text.indexOf("TWO")
  expect(spans.some(span => span.start === removed && span.end === removed + 3 && span.face === "diffRefineRemoved")).toBe(true)
  expect(spans.some(span => span.start === added && span.end === added + 3 && span.face === "diffRefineAdded")).toBe(true)
})

test("diff-refine-hunk highlights changed substrings in context hunks", async () => {
  const editor = makeEditor()
  const buffer = editor.scratch("*diff*", sample, "diff-mode")
  buffer.point = buffer.text.indexOf("+TWO")
  await editor.run("diff-unified->context")
  buffer.point = buffer.text.indexOf("! TWO")
  await editor.run("diff-refine-hunk")
  const spans = editor.fontLock(buffer)
  const removed = buffer.text.indexOf("two")
  const added = buffer.text.indexOf("TWO")
  expect(spans.some(span => span.start === removed && span.end === removed + 3 && span.face === "diffRefineRemoved")).toBe(true)
  expect(spans.some(span => span.start === added && span.end === added + 3 && span.face === "diffRefineAdded")).toBe(true)
})

test("diff-ediff-patch opens a read-only patched preview beside source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-diff-ediff-"))
  try {
    await writeFile(join(dir, "a.txt"), "one\ntwo\n")
    const editor = makeEditor()
    const buffer = editor.scratch("*diff*", sample, "diff-mode")
    buffer.locals.set("diff-default-directory", dir)
    buffer.point = buffer.text.indexOf("+TWO")
    await editor.run("diff-ediff-patch")
    const preview = [...editor.buffers.values()].find(b => b.name === "*diff-ediff-patch: a.txt*")
    expect(preview?.text).toBe("one\nTWO\nthree\n")
    expect(preview?.readOnly).toBe(true)
    expect([...editor.buffers.values()].find(b => b.path === join(dir, "a.txt"))?.text).toBe("one\ntwo\n")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("diff-add-change-log-entries-other-window creates entries for diff hunks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-diff-changelog-"))
  const oldUser = process.env.USER
  const oldName = process.env.GIT_AUTHOR_NAME
  const oldEmail = process.env.GIT_AUTHOR_EMAIL
  try {
    process.env.USER = "jemacs"
    delete process.env.GIT_AUTHOR_NAME
    delete process.env.GIT_AUTHOR_EMAIL
    const editor = makeEditor()
    const buffer = editor.scratch("*diff*", sample, "diff-mode")
    buffer.locals.set("diff-default-directory", dir)
    await editor.run("diff-add-change-log-entries-other-window")
    const changeLog = [...editor.buffers.values()].find(b => b.path === join(dir, "ChangeLog"))
    expect(changeLog).toBeDefined()
    if (!changeLog) throw new Error("ChangeLog buffer was not opened")
    expect(changeLog.text).toContain("  jemacs\n\n")
    expect(changeLog.text).toContain("\t* a.txt (function name): ")
    expect(changeLog.text).toContain("\t* b.txt: ")
    expect(editor.currentBuffer).toBe(changeLog)
  } finally {
    if (oldUser == null) delete process.env.USER
    else process.env.USER = oldUser
    if (oldName == null) delete process.env.GIT_AUTHOR_NAME
    else process.env.GIT_AUTHOR_NAME = oldName
    if (oldEmail == null) delete process.env.GIT_AUTHOR_EMAIL
    else process.env.GIT_AUTHOR_EMAIL = oldEmail
    await rm(dir, { recursive: true, force: true })
  }
})
