import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BufferModel, inferMode } from "../../src/kernel/buffer"
import { getMode } from "../../src/modes/mode"
import { getMinorMode } from "../../src/modes/minor-mode"
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
  expect(mode?.keymap?.get("ESC n")).toBe("diff-hunk-next")
  expect(mode?.keymap?.get("ESC S-w")).toBe("widen")
  expect(mode?.keymap?.get("C-c C-a")).toBe("diff-apply-hunk")
  expect(editor.commands.get("diff-hunk-next")).toBeDefined()
  expect(editor.commands.get("diff-make-unified")).toBeDefined()
  expect(editor.commands.get("diff-sanity-check-hunk")).toBeDefined()
  expect(editor.commands.get("diff-current-defun")).toBeDefined()
  expect(editor.commands.get("diff-add-log-current-defuns")).toBeDefined()
  expect(editor.commands.get("diff-find-file-name")).toBeDefined()
  expect(editor.commands.get("diff-buffer-file-names")).toBeDefined()
  expect(editor.commands.get("diff-tell-file-name")).toBeDefined()
  expect(editor.commands.get("diff-delete-empty-files")).toBeDefined()
  expect(editor.commands.get("diff-delete-if-empty")).toBeDefined()
  expect(inferMode("change.patch")).toBe("diff-mode")
  expect(inferMode("change.diff")).toBe("diff-mode")
})

test("diff-minor-mode exposes Emacs shared diff bindings under C-c =", async () => {
  const editor = makeEditor()
  const buffer = editor.scratch("*text*", sample, "text")
  const minor = getMinorMode("diff-minor-mode")
  expect(minor?.keymap?.get("C-c = n")).toBe("diff-hunk-next")
  expect(minor?.keymap?.get("C-c = S-w")).toBe("widen")
  await editor.run("diff-minor-mode")
  expect(buffer.minorModes.has("diff-minor-mode")).toBe(true)
  expect(editor.keymaps.lookup("C-c = n")).toMatchObject({ status: "matched", command: "diff-hunk-next" })
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

test("diff-next-complex-hunk skips unified hunks with unchanged line counts", async () => {
  const editor = makeEditor()
  const text = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "@@ -10,1 +10,2 @@",
    " context",
    "+added",
    "",
  ].join("\n")
  const buffer = editor.scratch("*diff*", text, "diff-mode")
  buffer.point = 0
  await editor.run("diff-next-complex-hunk")
  expect(buffer.text.slice(buffer.point).startsWith("@@ -10,1 +10,2 @@")).toBe(true)
})

test("diff-kill-creations-deletions removes created and deleted file diffs", async () => {
  const editor = makeEditor()
  const text = [
    "diff --git a/keep.txt b/keep.txt",
    "--- a/keep.txt",
    "+++ b/keep.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/deleted.txt b/deleted.txt",
    "--- a/deleted.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-gone",
    "diff --git a/new.txt b/new.txt",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1 @@",
    "+created",
    "",
  ].join("\n")
  const buffer = editor.scratch("*diff*", text, "diff-mode")
  await editor.run("diff-kill-creations-deletions")
  expect(buffer.text).toContain("diff --git a/keep.txt b/keep.txt")
  expect(buffer.text).toContain("+new")
  expect(buffer.text).not.toContain("deleted.txt")
  expect(buffer.text).not.toContain("new.txt")
  expect(buffer.text).not.toContain("+created")
})

test("diff-kill-junk removes empty Index blocks and junk before file headers", async () => {
  const editor = makeEditor()
  const text = [
    "Index: empty.txt",
    "===================================================================",
    "metadata with no hunk",
    "Index: keep.txt",
    "===================================================================",
    "stray metadata",
    "--- a/keep.txt",
    "+++ b/keep.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ].join("\n")
  const buffer = editor.scratch("*diff*", text, "diff-mode")
  await editor.run("diff-kill-junk")
  expect(buffer.text).not.toContain("empty.txt")
  expect(buffer.text).not.toContain("metadata with no hunk")
  expect(buffer.text).toContain("Index: keep.txt")
  expect(buffer.text).not.toContain("stray metadata")
  expect(buffer.text).toContain("--- a/keep.txt")
  expect(buffer.text).toContain("+new")
})

test("diff-delete-if-empty deletes an empty visited diff file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-diff-delete-empty-now-"))
  try {
    const path = join(dir, "empty.diff")
    await writeFile(path, "")
    const editor = makeEditor()
    await editor.openFile(path)
    await editor.run("diff-delete-if-empty")
    await expect(stat(path)).rejects.toThrow()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("diff-delete-empty-files removes the diff file after saving it empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-diff-delete-empty-save-"))
  try {
    const path = join(dir, "empty-after-save.diff")
    await writeFile(path, sample)
    const editor = makeEditor()
    const buffer = await editor.openFile(path)
    await editor.run("diff-delete-empty-files")
    buffer.setText("")
    await buffer.save({ runHook: (name, saved) => editor.runHook(name, saved), makeBackupFiles: false })
    await expect(stat(path)).rejects.toThrow()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("diff-delete-trailing-whitespace removes changed-line whitespace from diff and source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-diff-trailing-"))
  try {
    await writeFile(join(dir, "a.txt"), "one\nnew   \n")
    const text = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,2 @@",
      " one",
      "-old",
      "+new   ",
      "",
    ].join("\n")
    const editor = makeEditor()
    const buffer = editor.scratch("*diff*", text, "diff-mode")
    buffer.locals.set("diff-default-directory", dir)
    await editor.run("diff-delete-trailing-whitespace")
    expect(buffer.text).toContain("+new\n")
    expect(buffer.text).not.toContain("+new   ")
    expect(editor.currentBuffer.text).toBe("one\nnew\n")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("diff-goto-source resolves prefixed diff paths by dropping leading directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-diff-source-"))
  try {
    await writeFile(join(dir, "a.txt"), "one\nnew\n")
    const text = [
      "diff --git a/src/a.txt b/src/a.txt",
      "--- a/src/a.txt",
      "+++ b/src/a.txt",
      "@@ -1,2 +1,2 @@",
      " one",
      "-old",
      "+new",
      "",
    ].join("\n")
    const editor = makeEditor()
    const buffer = editor.scratch("*diff*", text, "diff-mode")
    buffer.locals.set("diff-default-directory", dir)
    buffer.point = buffer.text.indexOf("+new")
    await editor.run("diff-goto-source")
    expect(editor.currentBuffer.path).toBe(resolve(dir, "a.txt"))
    expect(editor.currentBuffer.point).toBe(editor.currentBuffer.lineBounds(1)[0])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("diff-find-file-name reports the resolved source file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-diff-find-file-"))
  try {
    await writeFile(join(dir, "a.txt"), "one\nnew\n")
    const text = [
      "diff --git a/src/a.txt b/src/a.txt",
      "--- a/src/a.txt",
      "+++ b/src/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n")
    const editor = makeEditor()
    let message = ""
    editor.events.on("message", ({ text }) => { if (text) message = text })
    const buffer = editor.scratch("*diff*", text, "diff-mode")
    buffer.locals.set("diff-default-directory", dir)
    buffer.point = text.indexOf("@@ -1 +1 @@")
    await editor.run("diff-find-file-name")
    expect(message).toBe(resolve(dir, "a.txt"))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("diff-buffer-file-names lists resolved files for every file diff", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-diff-buffer-files-"))
  try {
    await writeFile(join(dir, "a.txt"), "one\n")
    await writeFile(join(dir, "b.txt"), "two\n")
    const text = [
      "diff --git a/src/a.txt b/src/a.txt",
      "--- a/src/a.txt",
      "+++ b/src/a.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/lib/b.txt b/lib/b.txt",
      "--- a/lib/b.txt",
      "+++ b/lib/b.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n")
    const editor = makeEditor()
    const buffer = editor.scratch("*diff*", text, "diff-mode")
    buffer.locals.set("diff-default-directory", dir)
    await editor.run("diff-buffer-file-names")
    expect(editor.currentBuffer.name).toBe("*diff-buffer-file-names*")
    expect(editor.currentBuffer.readOnly).toBe(true)
    expect(editor.currentBuffer.text).toContain(`${resolve(dir, "a.txt")}\n`)
    expect(editor.currentBuffer.text).toContain(`${resolve(dir, "b.txt")}\n`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("diff-tell-file-name remembers an explicit source file for the current hunk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-diff-tell-file-"))
  try {
    const actual = join(dir, "actual.txt")
    await writeFile(actual, "one\nnew\n")
    const text = [
      "diff --git a/missing.txt b/missing.txt",
      "--- a/missing.txt",
      "+++ b/missing.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n")
    const editor = makeEditor()
    let message = ""
    editor.events.on("message", ({ text }) => { if (text) message = text })
    const buffer = editor.scratch("*diff*", text, "diff-mode")
    buffer.locals.set("diff-default-directory", dir)
    buffer.point = text.indexOf("@@ -1 +1 @@")
    await editor.run("diff-tell-file-name", [actual])
    expect(message).toBe(`Remembered ${actual}`)
    await editor.run("diff-find-file-name")
    expect(message).toBe(actual)
    await editor.run("diff-goto-source")
    expect(editor.currentBuffer.path).toBe(actual)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("diff-sanity-check-hunk reports well-formed and malformed unified hunks", async () => {
  const editor = makeEditor()
  const messages: string[] = []
  editor.events.on("message", ({ text }) => { if (text) messages.push(text) })
  const buffer = editor.scratch("*diff*", sample, "diff-mode")
  buffer.point = buffer.text.indexOf("@@ -1,2 +1,3 @@")
  await editor.run("diff-sanity-check-hunk")
  expect(messages.at(-1)).toBe("Hunk is well formed")

  const malformed = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,2 +1,3 @@",
    " one",
    "-two",
    "+TWO",
    "",
  ].join("\n")
  buffer.setText(malformed)
  buffer.point = malformed.indexOf("@@ -1,2 +1,3 @@")
  await editor.run("diff-sanity-check-hunk")
  expect(messages.at(-1)).toBe("End of hunk ambiguously marked")
})

test("diff-goto-source refuses malformed hunks before opening source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-diff-sanity-source-"))
  try {
    await writeFile(join(dir, "a.txt"), "one\nTWO\nthree\n")
    const malformed = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      "",
    ].join("\n")
    const editor = makeEditor()
    const messages: string[] = []
    editor.events.on("message", ({ text }) => { if (text) messages.push(text) })
    const buffer = editor.scratch("*diff*", malformed, "diff-mode")
    buffer.locals.set("diff-default-directory", dir)
    buffer.point = malformed.indexOf("+TWO")
    await editor.run("diff-goto-source")
    expect(editor.currentBuffer).toBe(buffer)
    expect(messages.at(-1)).toBe("End of hunk ambiguously marked")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("diff-delete-trailing-whitespace with prefix cleans the old side", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-diff-trailing-old-"))
  try {
    await writeFile(join(dir, "a.txt"), "one\nold   \n")
    const text = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,2 @@",
      " one",
      "-old   ",
      "+new",
      "",
    ].join("\n")
    const editor = makeEditor()
    const buffer = editor.scratch("*diff*", text, "diff-mode")
    buffer.locals.set("diff-default-directory", dir)
    editor.prefixArg.universalArgument()
    await editor.run("diff-delete-trailing-whitespace")
    expect(buffer.text).toContain("-old\n")
    expect(buffer.text).not.toContain("-old   ")
    expect(editor.currentBuffer.text).toBe("one\nold\n")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("diff-delete-trailing-whitespace resolves prefixed source paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-diff-trailing-prefix-"))
  try {
    await writeFile(join(dir, "a.txt"), "one\nnew   \n")
    const text = [
      "diff --git a/src/a.txt b/src/a.txt",
      "--- a/src/a.txt",
      "+++ b/src/a.txt",
      "@@ -1,2 +1,2 @@",
      " one",
      "-old",
      "+new   ",
      "",
    ].join("\n")
    const editor = makeEditor()
    const buffer = editor.scratch("*diff*", text, "diff-mode")
    buffer.locals.set("diff-default-directory", dir)
    await editor.run("diff-delete-trailing-whitespace")
    expect(editor.currentBuffer.path).toBe(resolve(dir, "a.txt"))
    expect(editor.currentBuffer.text).toBe("one\nnew\n")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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

test("diff-apply-hunk resolves prefixed source paths before applying", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-diff-apply-prefix-"))
  try {
    await writeFile(join(dir, "a.txt"), "one\ntwo\n")
    const text = [
      "diff --git a/src/a.txt b/src/a.txt",
      "--- a/src/a.txt",
      "+++ b/src/a.txt",
      "@@ -1,2 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      "+three",
      "",
    ].join("\n")
    const editor = makeEditor()
    const buffer = editor.scratch("*diff*", text, "diff-mode")
    buffer.locals.set("diff-default-directory", dir)
    buffer.point = buffer.text.indexOf("@@ -1,2")
    await editor.run("diff-test-hunk")
    await editor.run("diff-apply-hunk")
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("one\nTWO\nthree\n")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("diff-kill-applied-hunks removes hunks already present in the source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-diff-kill-applied-"))
  try {
    await writeFile(join(dir, "a.txt"), "one\nTWO\nthree\n")
    const text = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      "+three",
      "@@ -10 +11 @@",
      "-old",
      "+new",
      "",
    ].join("\n")
    const editor = makeEditor()
    const buffer = editor.scratch("*diff*", text, "diff-mode")
    buffer.locals.set("diff-default-directory", dir)
    buffer.point = buffer.text.indexOf("@@ -1,2")
    await editor.run("diff-kill-applied-hunks")
    expect(buffer.text).not.toContain("@@ -1,2 +1,3 @@")
    expect(buffer.text).not.toContain("+three")
    expect(buffer.text).toContain("@@ -10 +11 @@")
    expect(buffer.text).toContain("+new")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("diff-kill-applied-hunks resolves prefixed paths when detecting applied hunks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-diff-kill-applied-prefix-"))
  try {
    await writeFile(join(dir, "a.txt"), "one\nTWO\nthree\n")
    const text = [
      "diff --git a/src/a.txt b/src/a.txt",
      "--- a/src/a.txt",
      "+++ b/src/a.txt",
      "@@ -1,2 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      "+three",
      "@@ -10 +11 @@",
      "-old",
      "+new",
      "",
    ].join("\n")
    const editor = makeEditor()
    const buffer = editor.scratch("*diff*", text, "diff-mode")
    buffer.locals.set("diff-default-directory", dir)
    buffer.point = buffer.text.indexOf("@@ -1,2")
    await editor.run("diff-kill-applied-hunks")
    expect(buffer.text).not.toContain("@@ -1,2 +1,3 @@")
    expect(buffer.text).not.toContain("+three")
    expect(buffer.text).toContain("@@ -10 +11 @@")
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

test("diff-make-unified converts context hunks across the buffer", async () => {
  const editor = makeEditor()
  const buffer = editor.scratch("*diff*", sample, "diff-mode")
  buffer.point = buffer.text.indexOf("+TWO")
  await editor.run("diff-unified->context")
  expect(buffer.text).toContain("***************")

  await editor.run("diff-make-unified")
  expect(buffer.text).not.toContain("***************")
  expect(buffer.text).toContain("@@ -1,2 +1,3 @@")
  expect(buffer.text).toContain("-two")
  expect(buffer.text).toContain("+TWO")
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
    const preview = [...editor.buffers.values()].find(b => b.locals.get("diff-ediff-source") === resolve(dir, "a.txt"))
    expect(preview?.text).toBe("one\nTWO\nthree\n")
    expect(preview?.readOnly).toBe(true)
    expect([...editor.buffers.values()].find(b => b.path === join(dir, "a.txt"))?.text).toBe("one\ntwo\n")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("diff-ediff-patch resolves prefixed source paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-diff-ediff-prefix-"))
  try {
    await writeFile(join(dir, "a.txt"), "one\ntwo\n")
    const text = [
      "diff --git a/src/a.txt b/src/a.txt",
      "--- a/src/a.txt",
      "+++ b/src/a.txt",
      "@@ -1,2 +1,3 @@",
      " one",
      "-two",
      "+TWO",
      "+three",
      "",
    ].join("\n")
    const editor = makeEditor()
    const buffer = editor.scratch("*diff*", text, "diff-mode")
    buffer.locals.set("diff-default-directory", dir)
    buffer.point = buffer.text.indexOf("+TWO")
    await editor.run("diff-ediff-patch")
    const preview = [...editor.buffers.values()].find(b => b.locals.get("diff-ediff-source") === resolve(dir, "a.txt"))
    expect(preview?.text).toBe("one\nTWO\nthree\n")
    expect([...editor.buffers.values()].find(b => b.path === resolve(dir, "a.txt"))?.text).toBe("one\ntwo\n")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("diff-current-defun reports the current hunk function name", async () => {
  const editor = makeEditor()
  const messages: string[] = []
  editor.events.on("message", ({ text }) => { if (text) messages.push(text) })
  const buffer = editor.scratch("*diff*", sample, "diff-mode")
  buffer.point = buffer.text.indexOf("@@ -1,2")
  await editor.run("diff-current-defun")
  expect(messages.at(-1)).toBe("function name")

  buffer.point = buffer.text.indexOf("@@ -1 +1")
  await editor.run("diff-current-defun")
  expect(messages.at(-1)).toBe("No current defun")
})

test("diff-add-log-current-defuns groups hunk defuns by file", async () => {
  const editor = makeEditor()
  const text = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1 +1 @@ alpha",
    "-old",
    "+new",
    "@@ -10 +10 @@ beta",
    "-old",
    "+new",
    "diff --git a/b.txt b/b.txt",
    "--- a/b.txt",
    "+++ b/b.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ].join("\n")
  editor.scratch("*diff*", text, "diff-mode")
  await editor.run("diff-add-log-current-defuns")
  const out = editor.currentBuffer
  expect(out.name).toBe("*diff-current-defuns*")
  expect(out.readOnly).toBe(true)
  expect(out.text).toContain("a.txt: alpha, beta\n")
  expect(out.text).toContain("b.txt: \n")
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
