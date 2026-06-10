import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import type { Editor } from "../kernel/editor"
import type { BufferModel } from "../kernel/buffer"
import { addHook, getHooks } from "../kernel/hooks"
import { Keymap } from "../kernel/keymap"
import { spawnProcess } from "../platform/runtime"
import { killNew } from "../runtime/kill-ring"
import { defineMode, type TextSpan } from "./mode"
import { defineMinorMode } from "./minor-mode"

export type DiffHunkStyle = "unified" | "context" | "normal"

export type DiffHunk = {
  style: DiffHunkStyle
  startLine: number
  endLine: number
  oldStart?: number
  oldCount?: number
  newStart?: number
  newCount?: number
}

export type DiffFile = {
  startLine: number
  endLine: number
  oldFile?: string
  newFile?: string
  hunks: DiffHunk[]
}

type Line = { text: string; start: number; end: number }
const DIFF_NARROW_LOCAL = "diff-narrowed-region"
const DIFF_REFINE_LOCAL = "diff-refine-spans"
const DIFF_REMEMBERED_FILES_LOCAL = "diff-remembered-files"
const DIFF_DELETE_EMPTY_FILES_LOCAL = "diff-delete-empty-files"

export function installDiffMode(): void {
  const keymap = new Keymap("diff-mode-map")
  const sharedBindings = [
    ["n", "diff-hunk-next"],
    ["S-n", "diff-file-next"],
    ["p", "diff-hunk-prev"],
    ["S-p", "diff-file-prev"],
    ["tab", "diff-hunk-next"],
    ["backtab", "diff-hunk-prev"],
    ["k", "diff-hunk-kill"],
    ["S-k", "diff-file-kill"],
    ["}", "diff-file-next"],
    ["{", "diff-file-prev"],
    ["return", "diff-goto-source"],
    ["RET", "diff-goto-source"],
    ["o", "diff-goto-source"],
    ["w", "diff-kill-ring-save"],
    ["S-a", "diff-ediff-patch"],
    ["r", "diff-restrict-view"],
    ["S-r", "diff-reverse-direction"],
    ["s", "diff-split-hunk"],
    ["u", "diff-revert-and-kill-hunk"],
    ["@", "diff-revert-and-kill-hunk"],
  ] as const
  for (const [key, command] of sharedBindings) {
    keymap.bind(key, command)
    keymap.bind(`ESC ${key}`, command)
  }
  for (const [key, command] of [
    ["C-c C-c", "diff-goto-source"],
    ["C-x 4 A", "diff-add-change-log-entries-other-window"],
    ["C-c C-a", "diff-apply-hunk"],
    ["C-c M-u", "diff-revert-and-kill-hunk"],
    ["C-c C-m a", "diff-apply-buffer"],
    ["C-c C-m n", "diff-delete-other-hunks"],
    ["C-c C-m k", "diff-kill-applied-hunks"],
    ["C-c C-e", "diff-ediff-patch"],
    ["C-c C-n", "diff-restrict-view"],
    ["C-c C-s", "diff-split-hunk"],
    ["C-c C-t", "diff-test-hunk"],
    ["C-c C-r", "diff-reverse-direction"],
    ["C-c C-u", "diff-context->unified"],
    ["C-c C-d", "diff-unified->context"],
    ["C-c C-w", "diff-ignore-whitespace-hunk"],
    ["C-c C-l", "diff-refresh-hunk"],
    ["C-c C-b", "diff-refine-hunk"],
  ] as const) keymap.bind(key, command)
  keymap.bind("S-w", "widen")
  keymap.bind("ESC S-w", "widen")
  defineMode({
    name: "diff-mode",
    parent: "text",
    keymap,
    fontLock: diffFontLock,
    beginningOfDefun: diffBeginningOfFileAndJunk,
    endOfDefun: diffEndOfFile,
    displayFilter: diffDisplayFilter,
  })
  const minorMap = new Keymap("diff-minor-mode-map")
  for (const [key, command] of sharedBindings) minorMap.bind(`C-c = ${key}`, command)
  minorMap.bind("C-c = S-w", "widen")
  defineMinorMode({
    name: "diff-minor-mode",
    lighter: " Diff",
    keymap: minorMap,
  })
}

export function installDiffCommands(editor: Editor): void {
  editor.command("diff-hunk-next", ({ buffer, prefixArgument }) => {
    moveToHunk(buffer, prefixCount(prefixArgument), 1)
  }, "Move to the next diff hunk.")

  editor.command("diff-hunk-prev", ({ buffer, prefixArgument }) => {
    moveToHunk(buffer, prefixCount(prefixArgument), -1)
  }, "Move to the previous diff hunk.")

  editor.command("diff-file-next", ({ buffer, prefixArgument }) => {
    moveToFile(buffer, prefixCount(prefixArgument), 1)
  }, "Move to the next file in the diff.")

  editor.command("diff-file-prev", ({ buffer, prefixArgument }) => {
    moveToFile(buffer, prefixCount(prefixArgument), -1)
  }, "Move to the previous file in the diff.")

  editor.command("diff-next-complex-hunk", ({ buffer, editor }) => {
    if (!moveToNextComplexHunk(buffer)) editor.message("No next complex hunk")
  }, "Jump to the next unified hunk that changes the number of lines.")

  editor.command("diff-sanity-check-hunk", ({ buffer, editor }) => {
    const result = sanityCheckHunkAtPoint(buffer)
    editor.message(result.ok ? "Hunk is well formed" : result.error)
  }, "Check whether the current hunk is well formed.")

  editor.command("diff-hunk-kill", ({ buffer, editor }) => {
    const hunk = diffHunkAtPoint(buffer)
    if (!hunk) return editor.message("No hunk at point")
    deleteLines(buffer, hunk.startLine, hunk.endLine)
  }, "Kill the current diff hunk.")

  editor.command("diff-file-kill", ({ buffer, editor }) => {
    const file = diffFileAtPoint(buffer)
    if (!file) return editor.message("No file at point")
    deleteLines(buffer, file.startLine, file.endLine)
  }, "Kill the current file's diff.")

  editor.command("diff-kill-creations-deletions", ({ buffer, editor }) => {
    const count = killCreationsDeletions(buffer)
    editor.message(count ? `Killed ${count} creation/deletion file diff${count === 1 ? "" : "s"}` : "No creation/deletion file diffs")
  }, "Kill all hunks for file creations and deletions.")

  editor.command("diff-kill-junk", ({ buffer, editor }) => {
    const count = killJunk(buffer)
    editor.message(count ? `Killed ${count} junk block${count === 1 ? "" : "s"}` : "No junk blocks")
  }, "Kill spurious empty diffs.")

  if (!getHooks("after-save-hook").includes(diffDeleteEmptyFilesAfterSave)) addHook("after-save-hook", diffDeleteEmptyFilesAfterSave)

  editor.command("diff-delete-if-empty", async ({ editor, buffer }) => {
    if (await diffDeleteIfEmpty(buffer)) editor.message("Deleted empty diff file")
    else editor.message("Diff file is not empty")
  }, "Delete the current diff file if it is empty.")

  editor.command("diff-delete-empty-files", ({ editor, buffer }) => {
    buffer.locals.set(DIFF_DELETE_EMPTY_FILES_LOCAL, true)
    editor.message("Will delete this diff file after saving it empty")
  }, "Arrange for empty diff files to be removed after save.")

  editor.command("diff-delete-trailing-whitespace", async ({ editor, buffer, prefixArgument }) => {
    const count = await deleteTrailingWhitespaceFromDiff(editor, buffer, prefixArgument != null)
    editor.message(count ? `Deleted trailing whitespace from ${count} line${count === 1 ? "" : "s"}` : "No trailing whitespace to delete")
  }, "Remove trailing whitespace from lines modified in this diff and their source files.")

  editor.command("diff-make-unified", async ({ editor, buffer }) => {
    const count = await makeUnifiedDiff(editor, buffer)
    editor.message(count ? `Converted ${count} context hunk${count === 1 ? "" : "s"} to unified diff` : "No context hunks to convert")
  }, "Turn context diffs into unified diffs.")

  editor.command("diff-delete-other-hunks", ({ buffer, editor }) => {
    const keep = diffHunkAtPoint(buffer)
    if (!keep) return editor.message("No hunk at point")
    const lines = lineInfo(buffer)
    const kept = lines.slice(keep.startLine, keep.endLine + 1).map(l => l.text).join("\n")
    buffer.setText(kept + (kept.endsWith("\n") ? "" : "\n"))
  }, "Delete hunks other than the current hunk.")

  editor.command("diff-restrict-view", ({ buffer, editor, prefixArgument }) => {
    const bounds = prefixArgument != null ? boundsOfFile(buffer) : boundsOfHunk(buffer)
    if (!bounds) return editor.message(prefixArgument != null ? "No file at point" : "No hunk at point")
    buffer.locals.set(DIFF_NARROW_LOCAL, bounds)
    buffer.point = Math.max(bounds.start, Math.min(buffer.point, bounds.end))
  }, "Restrict the view to the current hunk, or current file with a prefix argument.")

  editor.command("widen", ({ buffer }) => {
    buffer.locals.delete(DIFF_NARROW_LOCAL)
  }, "Remove narrowing from the current buffer.")

  editor.command("diff-split-hunk", ({ buffer, editor }) => {
    if (!splitUnifiedHunk(buffer)) editor.message("diff-split-hunk only works inside a splittable unified hunk")
  }, "Split the current unified diff hunk at point.")

  editor.command("diff-kill-ring-save", ({ editor, buffer, prefixArgument }) => {
    const hunk = diffHunkAtPoint(buffer)
    if (!hunk) return editor.message("No hunk at point")
    killNew(editor, hunkAppliedText(buffer, hunk, prefixArgument == null))
    buffer.markActive = false
    editor.message(prefixArgument == null ? "Copied modified text" : "Copied original text")
  }, "Copy the modified text from the current hunk to the kill ring.")

  editor.command("diff-reverse-direction", ({ buffer }) => {
    reverseDiffDirection(buffer)
  }, "Reverse the direction of the diff.")

  editor.command("diff-goto-source", async ({ editor, buffer }) => {
    const loc = sourceLocationAtPoint(buffer)
    if (!loc) return editor.message("No source location at point")
    const sanity = sanityCheckHunkAtPoint(buffer)
    if (!sanity.ok) return editor.message(sanity.error)
    const file = await diffFindFileName(buffer, false) ?? await resolveDiffFileName(buffer, loc.file)
    const source = await editor.openFile(file)
    const line = Math.max(0, loc.line - 1)
    source.point = source.lineBounds(Math.min(line, source.lineCount - 1))[0]
  }, "Visit the source location corresponding to point.")

  editor.command("diff-find-file-name", async ({ editor, buffer, prefixArgument }) => {
    const file = await diffFindFileName(buffer, prefixArgument != null)
    editor.message(file ?? "Can't find the file")
  }, "Return the file corresponding to the current patch.")

  editor.command("diff-buffer-file-names", async ({ editor, buffer, prefixArgument }) => {
    const files = await diffBufferFileNames(buffer, prefixArgument != null)
    const out = editor.scratch("*diff-buffer-file-names*", files.join("\n") + (files.length ? "\n" : ""), "text")
    out.readOnly = true
    editor.message(files.length ? `Found ${files.length} file${files.length === 1 ? "" : "s"}` : "No file names found")
  }, "Return file names corresponding to all hunks in this diff buffer.")

  editor.command("diff-tell-file-name", ({ editor, buffer, args, prefixArgument }) => {
    const name = args[0]
    if (!name) return editor.message("No file name supplied")
    if (!rememberDiffFileName(buffer, prefixArgument != null, name)) return editor.message("No file name to look for")
    editor.message(`Remembered ${name}`)
  }, "Tell diff-mode where to find the source file of the current hunk.")

  editor.command("diff-apply-hunk", async ({ editor, buffer }) => {
    const patch = patchAtPoint(buffer)
    if (!patch) return editor.message("No hunk at point")
    await applyPatchText(editor, buffer, patch, false, false)
  }, "Apply the current hunk.")

  editor.command("diff-test-hunk", async ({ editor, buffer }) => {
    const patch = patchAtPoint(buffer)
    if (!patch) return editor.message("No hunk at point")
    await applyPatchText(editor, buffer, patch, false, true)
  }, "Test whether the current hunk applies.")

  editor.command("diff-apply-buffer", async ({ editor, buffer }) => {
    await applyPatchText(editor, buffer, buffer.text, false, false)
  }, "Apply all hunks in the current diff buffer.")

  editor.command("diff-kill-applied-hunks", async ({ editor, buffer }) => {
    const count = await killAppliedHunks(buffer)
    editor.message(count ? `Killed ${count} already-applied hunk${count === 1 ? "" : "s"}` : "No already-applied hunks")
  }, "Kill all hunks starting at point that have already been applied.")

  editor.command("diff-revert-and-kill-hunk", async ({ editor, buffer }) => {
    const hunk = diffHunkAtPoint(buffer)
    const patch = patchAtPoint(buffer)
    if (!hunk || !patch) return editor.message("No hunk at point")
    const ok = await applyPatchText(editor, buffer, patch, true, false)
    if (ok) deleteLines(buffer, hunk.startLine, hunk.endLine)
  }, "Reverse-apply and then kill the current hunk.")

  editor.command("diff-ediff-patch", async ({ editor, buffer }) => {
    if (!(await previewPatchedHunk(editor, buffer))) editor.message("No source hunk at point")
  }, "Show the current hunk's source and patched result in another window.")

  editor.command("diff-add-change-log-entries-other-window", async ({ editor, buffer }) => {
    if (!(await addChangeLogEntriesOtherWindow(editor, buffer))) editor.message("No change log entries found")
  }, "Add ChangeLog entries for the current diff in another window.")

  editor.command("diff-current-defun", ({ editor, buffer }) => {
    const defun = diffCurrentDefun(buffer)
    editor.message(defun ? defun : "No current defun")
  }, "Find the function name for the current diff hunk.")

  editor.command("diff-add-log-current-defuns", ({ editor, buffer }) => {
    const entries = diffAddLogCurrentDefuns(buffer)
    const text = entries.map(entry => `${entry.file}: ${entry.defuns.join(", ")}`).join("\n") + (entries.length ? "\n" : "")
    const out = editor.scratch("*diff-current-defuns*", text, "text")
    out.readOnly = true
    editor.message(entries.length ? `Found defuns for ${entries.length} file${entries.length === 1 ? "" : "s"}` : "No diff defuns found")
  }, "Return defun names for the current diff.")

  editor.command("diff-refine-hunk", ({ buffer, editor }) => {
    if (!refineHunk(buffer)) editor.message("No refinable hunk at point")
  }, "Highlight changes of the hunk at point at a finer granularity.")

  editor.command("diff-refresh-hunk", async ({ editor, buffer }) => {
    if (!(await replaceHunkWithDiff(editor, buffer, currentHunkStyle(buffer), false))) editor.message("No hunk at point")
  }, "Re-diff the current hunk.")

  editor.command("diff-ignore-whitespace-hunk", async ({ editor, buffer }) => {
    if (!(await replaceHunkWithDiff(editor, buffer, currentHunkStyle(buffer), true))) editor.message("No hunk at point")
  }, "Re-diff the current hunk ignoring whitespace changes.")

  editor.command("diff-context->unified", async ({ editor, buffer }) => {
    if (!(await replaceHunkWithDiff(editor, buffer, "unified", false))) editor.message("No hunk at point")
  }, "Convert the current context diff hunk to unified format.")

  editor.command("diff-unified->context", async ({ editor, buffer }) => {
    if (!(await replaceHunkWithDiff(editor, buffer, "context", false))) editor.message("No hunk at point")
  }, "Convert the current unified diff hunk to context format.")
}

export function diffFontLock(buffer: BufferModel): TextSpan[] {
  const refined = buffer.locals.get(DIFF_REFINE_LOCAL) as TextSpan[] | undefined
  return [...diffFontLockText(buffer.text), ...(refined ?? [])]
}

export function diffFontLockText(text: string): TextSpan[] {
  const spans: TextSpan[] = []
  for (const line of textLines(text)) {
    const s = line.start
    const e = line.end
    const text = line.text
    if (!text) continue
    const hunk = /^(@@ .+? @@)(.*)$/.exec(text)
    if (hunk) {
      spans.push({ start: s, end: s + hunk[1]!.length, face: "diffHunkHeader" })
      if (hunk[2]) spans.push({ start: s + hunk[1]!.length, end: e, face: "diffFunction" })
    } else if (/^\*{15}/.test(text) || /^\*\*\* .+ \*\*\*\*$/.test(text) || /^---$/.test(text) || /^[0-9,]+[acd][0-9,]+$/.test(text)) {
      spans.push({ start: s, end: e, face: "diffHunkHeader" })
    } else if (/^(---|\+\+\+|\*\*\*) /.test(text)) {
      spans.push({ start: s, end: e, face: "diffFileHeader" })
    } else if (/^(Index|revno): /.test(text) || /^index .*\.{2}/.test(text)) {
      spans.push({ start: s, end: e, face: "diffIndex" })
    } else if (/^(diff |new file mode |deleted file mode )/.test(text)) {
      spans.push({ start: s, end: e, face: "diffHeader" })
    } else if (/^Only in /.test(text) || /^Binary files .* differ$/.test(text)) {
      spans.push({ start: s, end: e, face: "diffNonexistent" })
    } else if (text.startsWith("+")) {
      spans.push({ start: s, end: e, face: "diffAdded" })
    } else if (text.startsWith("-")) {
      spans.push({ start: s, end: e, face: "diffRemoved" })
    } else if (text.startsWith("!")) {
      spans.push({ start: s, end: e, face: "diffChanged" })
    } else if (!/^[-=+*!<>#]/.test(text)) {
      spans.push({ start: s, end: e, face: "diffContext" })
    }
  }
  return spans
}

export function parseDiffBuffer(buffer: BufferModel): DiffFile[] {
  const lines = lineInfo(buffer)
  const files: DiffFile[] = []
  let current: DiffFile | null = null
  const ensureFile = (line: number): DiffFile => {
    if (!current) {
      current = { startLine: line, endLine: line, hunks: [] }
      files.push(current)
    }
    return current
  }

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.text
    if (/^diff --git /.test(text) || /^Index: /.test(text) || /^Only in /.test(text) || /^Binary files /.test(text)) {
      if (current) current.endLine = Math.max(current.endLine, i - 1)
      current = { startLine: i, endLine: i, hunks: [] }
      files.push(current)
      continue
    }
    if (/^\*{15}/.test(text)) {
      const file = ensureFile(i)
      file.hunks.push({ style: "context", startLine: i, endLine: i })
      file.endLine = i
      continue
    }
    const contextOld = /^\*\*\* (\d+)(?:,(\d+))? \*\*\*\*$/.exec(text)
    if (contextOld) {
      const file = ensureFile(i)
      const hunk = file.hunks.at(-1)
      if (hunk?.style === "context") {
        hunk.oldStart = Number(contextOld[1])
        hunk.oldCount = contextOld[2] ? Number(contextOld[2]) - Number(contextOld[1]) + 1 : 1
        hunk.endLine = i
        file.endLine = i
        continue
      }
    }
    const contextNew = /^--- (\d+)(?:,(\d+))? ----$/.exec(text)
    if (contextNew) {
      const file = ensureFile(i)
      const hunk = file.hunks.at(-1)
      if (hunk?.style === "context") {
        hunk.newStart = Number(contextNew[1])
        hunk.newCount = contextNew[2] ? Number(contextNew[2]) - Number(contextNew[1]) + 1 : 1
        hunk.endLine = i
        file.endLine = i
        continue
      }
    }
    const oldFile = /^(?:---|\*\*\*)\s+(.+?)(?:\t| \d| \*\*\*\*|$)/.exec(text)
    if (oldFile) {
      const file = ensureFile(i)
      if (text.startsWith("---")) file.oldFile = cleanDiffPath(oldFile[1]!)
      else if (!file.oldFile) file.oldFile = cleanDiffPath(oldFile[1]!)
      file.endLine = i
      continue
    }
    const newFile = /^\+\+\+\s+(.+?)(?:\t| \d|$)/.exec(text)
    if (newFile) {
      const file = ensureFile(i)
      file.newFile = cleanDiffPath(newFile[1]!)
      file.endLine = i
      continue
    }
    const unified = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(text)
    if (unified) {
      const file = ensureFile(i)
      const hunk: DiffHunk = {
        style: "unified",
        startLine: i,
        endLine: i,
        oldStart: Number(unified[1]),
        oldCount: unified[2] ? Number(unified[2]) : 1,
        newStart: Number(unified[3]),
        newCount: unified[4] ? Number(unified[4]) : 1,
      }
      file.hunks.push(hunk)
      file.endLine = i
      continue
    }
    const normal = /^(\d+)(?:,\d+)?[acd](\d+)(?:,\d+)?$/.exec(text)
    if (normal) {
      const file = ensureFile(i)
      file.hunks.push({ style: "normal", startLine: i, endLine: i, oldStart: Number(normal[1]), newStart: Number(normal[2]) })
      file.endLine = i
      continue
    }
    if (current) current.endLine = i
    const lastHunk = current?.hunks.at(-1)
    if (lastHunk && isHunkBodyLine(text, lastHunk.style)) lastHunk.endLine = i
  }
  if (current) current.endLine = lines.length - 1
  return files
}

export function diffHunkAtPoint(buffer: BufferModel): DiffHunk | null {
  const line = buffer.lineAt(buffer.point)
  for (const file of parseDiffBuffer(buffer)) {
    for (const hunk of file.hunks) {
      if (line >= hunk.startLine && line <= hunk.endLine) return hunk
    }
  }
  return null
}

export function diffFileAtPoint(buffer: BufferModel): DiffFile | null {
  const line = buffer.lineAt(buffer.point)
  return parseDiffBuffer(buffer).find(file => line >= file.startLine && line <= file.endLine) ?? null
}

function boundsOfHunk(buffer: BufferModel): { start: number; end: number } | null {
  const hunk = diffHunkAtPoint(buffer)
  if (!hunk) return null
  const lines = lineInfo(buffer)
  return {
    start: lines[hunk.startLine]?.start ?? 0,
    end: hunk.endLine + 1 < lines.length ? lines[hunk.endLine + 1]!.start : buffer.text.length,
  }
}

function boundsOfFile(buffer: BufferModel): { start: number; end: number } | null {
  const file = diffFileAtPoint(buffer)
  if (!file) return null
  const lines = lineInfo(buffer)
  return {
    start: lines[file.startLine]?.start ?? 0,
    end: file.endLine + 1 < lines.length ? lines[file.endLine + 1]!.start : buffer.text.length,
  }
}

function diffDisplayFilter(buffer: BufferModel): { text: string; map: (n: number) => number } | null {
  const narrowed = buffer.locals.get(DIFF_NARROW_LOCAL) as { start: number; end: number } | undefined
  if (!narrowed) return null
  const start = Math.max(0, Math.min(narrowed.start, buffer.text.length))
  const end = Math.max(start, Math.min(narrowed.end, buffer.text.length))
  return {
    text: buffer.text.slice(start, end),
    map: n => Math.max(0, Math.min(end, Math.max(start, n)) - start),
  }
}

function diffBeginningOfFileAndJunk(buffer: BufferModel): boolean {
  const file = diffFileAtPoint(buffer)
  if (!file) return false
  buffer.point = lineInfo(buffer)[file.startLine]?.start ?? 0
  return true
}

function diffEndOfFile(buffer: BufferModel): boolean {
  const file = diffFileAtPoint(buffer)
  if (!file) return false
  buffer.point = lineInfo(buffer)[file.endLine]?.end ?? buffer.text.length
  return true
}

function moveToHunk(buffer: BufferModel, count: number, dir: 1 | -1): void {
  const hunks = parseDiffBuffer(buffer).flatMap(file => file.hunks).sort((a, b) => a.startLine - b.startLine)
  if (!hunks.length) return
  const line = buffer.lineAt(buffer.point)
  let idx = dir > 0
    ? hunks.findIndex(h => h.startLine > line)
    : findLastIndex(hunks, h => h.startLine < line)
  if (idx < 0) idx = dir > 0 ? hunks.length - 1 : 0
  idx = Math.max(0, Math.min(hunks.length - 1, idx + dir * (Math.max(1, count) - 1)))
  buffer.point = lineInfo(buffer)[hunks[idx]!.startLine]?.start ?? buffer.point
}

function moveToNextComplexHunk(buffer: BufferModel): boolean {
  const line = buffer.lineAt(buffer.point)
  const hunk = parseDiffBuffer(buffer)
    .flatMap(file => file.hunks)
    .filter(h => h.style === "unified" && h.startLine > line && (h.oldCount ?? 0) !== (h.newCount ?? 0))
    .sort((a, b) => a.startLine - b.startLine)[0]
  if (!hunk) return false
  buffer.point = lineInfo(buffer)[hunk.startLine]?.start ?? buffer.point
  return true
}

function moveToFile(buffer: BufferModel, count: number, dir: 1 | -1): void {
  const files = parseDiffBuffer(buffer).sort((a, b) => a.startLine - b.startLine)
  if (!files.length) return
  const line = buffer.lineAt(buffer.point)
  const current = files.findIndex(f => line >= f.startLine && line <= f.endLine)
  let idx = current >= 0
    ? current + dir * Math.max(1, count)
    : dir > 0
      ? files.findIndex(f => f.startLine > line)
      : findLastIndex(files, f => f.endLine < line)
  if (idx < 0) idx = dir > 0 ? files.length - 1 : 0
  if (current < 0) idx = idx + dir * (Math.max(1, count) - 1)
  idx = Math.max(0, Math.min(files.length - 1, idx))
  buffer.point = lineInfo(buffer)[files[idx]!.startLine]?.start ?? buffer.point
}

function sourceLocationAtPoint(buffer: BufferModel): { file: string; line: number } | null {
  const file = diffFileAtPoint(buffer)
  const hunk = diffHunkAtPoint(buffer)
  if (!file || !hunk) return null
  const target = file.newFile && file.newFile !== "/dev/null" ? file.newFile : file.oldFile
  if (!target) return null
  let line = hunk.newStart ?? hunk.oldStart ?? 1
  const here = buffer.lineAt(buffer.point)
  const lines = lineInfo(buffer)
  for (let i = hunk.startLine + 1; i < Math.min(here, hunk.endLine + 1); i++) {
    const text = lines[i]?.text ?? ""
    if (hunk.style === "unified") {
      if (!text.startsWith("-")) line++
    } else if (!text.startsWith("***") && !text.startsWith("---") && !text.startsWith("-")) {
      line++
    }
  }
  return { file: target, line }
}

function sanityCheckHunkAtPoint(buffer: BufferModel): { ok: true } | { ok: false; error: string } {
  const hunk = diffHunkAtPoint(buffer)
  if (!hunk) return { ok: false, error: "Not recognizable hunk header" }
  if (hunk.style === "unified") return sanityCheckUnifiedHunk(buffer, hunk)
  if (hunk.style === "context") return sanityCheckContextHunk(buffer, hunk)
  return { ok: true }
}

function sanityCheckUnifiedHunk(buffer: BufferModel, hunk: DiffHunk): { ok: true } | { ok: false; error: string } {
  if (hunk.oldCount == null || hunk.newCount == null) return { ok: false, error: "Unrecognized unified diff hunk header format" }
  let before = hunk.oldCount
  let after = hunk.newCount
  const lines = lineInfo(buffer)
  for (let i = hunk.startLine + 1; i <= hunk.endLine; i++) {
    const text = lines[i]?.text ?? ""
    if (text.startsWith(" ")) {
      before--
      after--
    } else if (text.startsWith("-")) {
      before--
    } else if (text.startsWith("+")) {
      after--
    } else if (text.startsWith("\\")) {
      continue
    } else if (text === "" && before > 0 && after > 0) {
      before--
      after--
    } else {
      return { ok: false, error: "End of hunk ambiguously marked" }
    }
    if (before < 0 || after < 0) {
      return { ok: false, error: before === 0 || after === 0 ? "End of hunk ambiguously marked" : "Hunk seriously messed up" }
    }
  }
  if (before !== 0 || after !== 0) return { ok: false, error: "End of hunk ambiguously marked" }
  return { ok: true }
}

function sanityCheckContextHunk(buffer: BufferModel, hunk: DiffHunk): { ok: true } | { ok: false; error: string } {
  if (hunk.oldCount == null || hunk.newCount == null) return { ok: false, error: "Unrecognized context diff hunk header format" }
  const lines = lineInfo(buffer)
  const middle = lines.findIndex((line, index) => index > hunk.startLine && index <= hunk.endLine && /^--- \d/.test(line.text))
  if (middle < 0) return { ok: false, error: "Unrecognized context diff second hunk header format" }
  const oldResult = sanityCheckContextHunkHalf(lines.slice(hunk.startLine + 1, middle), hunk.oldCount)
  if (!oldResult.ok) return oldResult
  return sanityCheckContextHunkHalf(lines.slice(middle + 1, hunk.endLine + 1), hunk.newCount)
}

function sanityCheckContextHunkHalf(lines: Line[], expected: number): { ok: true } | { ok: false; error: string } {
  let count = 0
  for (const line of lines) {
    if (/^\*\*\* \d/.test(line.text) || /^--- \d/.test(line.text)) continue
    if (/^[ !+-] /.test(line.text)) count++
    else if (line.text.startsWith("!") || line.text.startsWith("+") || line.text.startsWith("-")) return { ok: false, error: "End of hunk ambiguously marked" }
    else if (line.text.trim() !== "") return { ok: false, error: "End of hunk ambiguously marked" }
  }
  return count === expected ? { ok: true } : { ok: false, error: "End of hunk ambiguously marked" }
}

function patchAtPoint(buffer: BufferModel): string | null {
  const file = diffFileAtPoint(buffer)
  const hunk = diffHunkAtPoint(buffer)
  if (!file || !hunk) return null
  return patchForHunk(buffer, file, hunk)
}

function patchForHunk(buffer: BufferModel, file: DiffFile, hunk: DiffHunk): string {
  const lines = lineInfo(buffer)
  const header = lines.slice(file.startLine, hunk.startLine)
    .filter(line => !/^@@|^\*{15}|^[0-9,]+[acd]/.test(line.text))
    .map(line => line.text)
  const body = lines.slice(hunk.startLine, hunk.endLine + 1).map(line => line.text)
  return [...header, ...body, ""].join("\n")
}

function splitUnifiedHunk(buffer: BufferModel): boolean {
  const hunk = diffHunkAtPoint(buffer)
  if (!hunk || hunk.style !== "unified" || hunk.oldStart == null || hunk.newStart == null) return false
  const splitLine = buffer.lineAt(buffer.point)
  if (splitLine <= hunk.startLine + 1 || splitLine > hunk.endLine) return false
  const lines = lineInfo(buffer)
  const before = lines.slice(hunk.startLine + 1, splitLine).map(l => l.text)
  const after = lines.slice(splitLine, hunk.endLine + 1).map(l => l.text)
  if (!before.length || !after.length) return false
  if (![...before, ...after].every(isUnifiedBodyLine)) return false

  const oldBefore = countUnifiedLines(before, "old")
  const newBefore = countUnifiedLines(before, "new")
  const oldAfter = countUnifiedLines(after, "old")
  const newAfter = countUnifiedLines(after, "new")
  if (oldBefore + newBefore === 0 || oldAfter + newAfter === 0) return false

  const headerLine = lines[hunk.startLine]!.text
  const suffix = /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@(.*)$/.exec(headerLine)?.[1] ?? ""
  const firstHeader = formatUnifiedHeader(hunk.oldStart, oldBefore, hunk.newStart, newBefore, suffix)
  const secondHeader = formatUnifiedHeader(hunk.oldStart + oldBefore, oldAfter, hunk.newStart + newBefore, newAfter, suffix)
  const nextLines = [
    ...lines.slice(0, hunk.startLine).map(l => l.text),
    firstHeader,
    ...before,
    secondHeader,
    ...after,
    ...lines.slice(hunk.endLine + 1).map(l => l.text),
  ]
  buffer.setText(nextLines.join("\n"))
  buffer.point = nextLines.slice(0, hunk.startLine + 1 + before.length).reduce((n, line) => n + line.length + 1, 0)
  return true
}

function hunkAppliedText(buffer: BufferModel, hunk: DiffHunk, destp: boolean): string {
  const lines = lineInfo(buffer).slice(hunk.startLine + 1, hunk.endLine + 1).map(l => l.text)
  if (hunk.style === "context") return contextHunkText(lines, destp)
  const out: string[] = []
  for (const line of lines) {
    if (hunk.style === "unified") {
      if (line.startsWith("\\ No newline")) continue
      if (line.startsWith(" ") || (destp && line.startsWith("+")) || (!destp && line.startsWith("-"))) out.push(line.slice(1))
    } else if (hunk.style === "normal") {
      if (destp && line.startsWith("> ")) out.push(line.slice(2))
      else if (!destp && line.startsWith("< ")) out.push(line.slice(2))
    }
  }
  return out.join("\n") + (out.length ? "\n" : "")
}

function refineHunk(buffer: BufferModel): boolean {
  const hunk = diffHunkAtPoint(buffer)
  if (!hunk) return false
  const bounds = boundsOfHunk(buffer)
  if (!bounds) return false
  const existing = (buffer.locals.get(DIFF_REFINE_LOCAL) as TextSpan[] | undefined)
    ?.filter(span => span.end <= bounds.start || span.start >= bounds.end) ?? []
  const spans = hunk.style === "context"
    ? refineContextHunk(buffer, hunk)
    : hunk.style === "unified"
      ? refineUnifiedHunk(buffer, hunk)
      : refineNormalHunk(buffer, hunk)
  if (!spans.length) return false
  buffer.locals.set(DIFF_REFINE_LOCAL, [...existing, ...spans])
  return true
}

function refineUnifiedHunk(buffer: BufferModel, hunk: DiffHunk): TextSpan[] {
  const lines = lineInfo(buffer)
  const spans: TextSpan[] = []
  for (let i = hunk.startLine + 1; i <= hunk.endLine; i++) {
    if (!lines[i]?.text.startsWith("-")) continue
    const removed: Line[] = []
    while (i <= hunk.endLine && lines[i]?.text.startsWith("-")) removed.push(lines[i++]!)
    while (i <= hunk.endLine && lines[i]?.text.startsWith("\\")) i++
    const added: Line[] = []
    while (i <= hunk.endLine && lines[i]?.text.startsWith("+")) added.push(lines[i++]!)
    i--
    refineLinePairs(removed, added, 1, spans)
  }
  return spans
}

function refineContextHunk(buffer: BufferModel, hunk: DiffHunk): TextSpan[] {
  const lines = lineInfo(buffer)
  const middle = lines.findIndex((line, index) => index > hunk.startLine && index <= hunk.endLine && /^--- \d/.test(line.text))
  if (middle < 0) return []
  const removed = lines.slice(hunk.startLine + 1, middle).filter(line => line.text.startsWith("! "))
  const added = lines.slice(middle + 1, hunk.endLine + 1).filter(line => line.text.startsWith("! "))
  const spans: TextSpan[] = []
  refineLinePairs(removed, added, 2, spans)
  return spans
}

function refineNormalHunk(buffer: BufferModel, hunk: DiffHunk): TextSpan[] {
  const lines = lineInfo(buffer).slice(hunk.startLine + 1, hunk.endLine + 1)
  const middle = lines.findIndex(line => line.text === "---")
  if (middle < 0) return []
  const removed = lines.slice(0, middle).filter(line => line.text.startsWith("< "))
  const added = lines.slice(middle + 1).filter(line => line.text.startsWith("> "))
  const spans: TextSpan[] = []
  refineLinePairs(removed, added, 2, spans)
  return spans
}

function refineLinePairs(removed: Line[], added: Line[], prefixLen: number, spans: TextSpan[]): void {
  const n = Math.min(removed.length, added.length)
  for (let i = 0; i < n; i++) {
    const r = removed[i]!
    const a = added[i]!
    const oldText = r.text.slice(prefixLen)
    const newText = a.text.slice(prefixLen)
    const [oldStart, oldEnd, newStart, newEnd] = changedSubstringBounds(oldText, newText)
    if (oldStart < oldEnd) spans.push({ start: r.start + prefixLen + oldStart, end: r.start + prefixLen + oldEnd, face: "diffRefineRemoved" })
    if (newStart < newEnd) spans.push({ start: a.start + prefixLen + newStart, end: a.start + prefixLen + newEnd, face: "diffRefineAdded" })
  }
}

function changedSubstringBounds(oldText: string, newText: string): [number, number, number, number] {
  let prefix = 0
  const maxPrefix = Math.min(oldText.length, newText.length)
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) prefix++
  let oldSuffix = oldText.length
  let newSuffix = newText.length
  while (oldSuffix > prefix && newSuffix > prefix && oldText[oldSuffix - 1] === newText[newSuffix - 1]) {
    oldSuffix--
    newSuffix--
  }
  return [prefix, oldSuffix, prefix, newSuffix]
}

function contextHunkText(lines: string[], destp: boolean): string {
  const out: string[] = []
  let newHalf = false
  for (const line of lines) {
    if (line.startsWith("--- ") && / ----$/.test(line)) {
      newHalf = true
      continue
    }
    if (line.startsWith("***************") || /^\*\*\* \d/.test(line)) continue
    if (line.startsWith("  ") && destp === newHalf) out.push(line.slice(2))
    else if (line.startsWith("! ") && destp === newHalf) out.push(line.slice(2))
    else if (destp && line.startsWith("+ ")) out.push(line.slice(2))
    else if (!destp && line.startsWith("- ")) out.push(line.slice(2))
  }
  return out.join("\n") + (out.length ? "\n" : "")
}

function currentHunkStyle(buffer: BufferModel): "unified" | "context" {
  return diffHunkAtPoint(buffer)?.style === "context" ? "context" : "unified"
}

async function replaceHunkWithDiff(editor: Editor, buffer: BufferModel, style: "unified" | "context", ignoreWhitespace: boolean): Promise<boolean> {
  const hunk = diffHunkAtPoint(buffer)
  if (!hunk) return false
  const oldText = hunkAppliedText(buffer, hunk, false)
  const newText = hunkAppliedText(buffer, hunk, true)
  const replacement = await diffTexts(editor, oldText, newText, style, ignoreWhitespace)
  if (replacement == null) return true
  replaceHunk(buffer, hunk, replacement)
  return true
}

async function makeUnifiedDiff(editor: Editor, buffer: BufferModel): Promise<number> {
  const hunks = parseDiffBuffer(buffer)
    .flatMap(file => file.hunks)
    .filter(hunk => hunk.style === "context")
    .sort((a, b) => b.startLine - a.startLine)
  for (const hunk of hunks) {
    const oldText = hunkAppliedText(buffer, hunk, false)
    const newText = hunkAppliedText(buffer, hunk, true)
    const replacement = await diffTexts(editor, oldText, newText, "unified", false)
    if (replacement != null) replaceHunk(buffer, hunk, replacement)
  }
  return hunks.length
}

async function diffTexts(
  editor: Editor,
  oldText: string,
  newText: string,
  style: "unified" | "context",
  ignoreWhitespace: boolean,
): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-diff-mode-"))
  const oldPath = join(dir, "old")
  const newPath = join(dir, "new")
  try {
    await writeFile(oldPath, oldText)
    await writeFile(newPath, newText)
    const args = [style === "unified" ? "-u" : "-c", ...(ignoreWhitespace ? ["-b"] : []), oldPath, newPath]
    const proc = spawnProcess({ cmd: ["diff", ...args], stdout: "pipe", stderr: "pipe" })
    const [out, err] = await Promise.all([
      proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
      proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
    ])
    const code = await proc.exited
    if (code === 0) return ""
    if (code !== 1) {
      editor.message(`diff failed: ${err.trim() || `exit ${code}`}`)
      return null
    }
    return stripDiffFileHeaders(out)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function stripDiffFileHeaders(text: string): string {
  const lines = text.split("\n")
  const start = lines.findIndex(line => line.startsWith("@@") || line.startsWith("***************"))
  if (start < 0) return ""
  const body = lines.slice(start).join("\n")
  return body.endsWith("\n") ? body : body + "\n"
}

function replaceHunk(buffer: BufferModel, hunk: DiffHunk, text: string): void {
  const lines = lineInfo(buffer)
  const start = lines[hunk.startLine]?.start ?? 0
  const end = hunk.endLine + 1 < lines.length ? lines[hunk.endLine + 1]!.start : buffer.text.length
  buffer.splice(start, end, text, { markDirty: true })
  buffer.point = start
}

async function applyPatchText(editor: Editor, buffer: BufferModel, patch: string, reverse: boolean, check: boolean): Promise<boolean> {
  const result = await runGitApplyResolved(buffer, patch, reverse, check)
  if (result.ok) {
    editor.message(check ? "Patch applies cleanly" : "Applied patch")
    return true
  }
  editor.message(`git apply failed: ${result.err.trim()}`)
  return false
}

async function runGitApplyResolved(buffer: BufferModel, patch: string, reverse: boolean, check: boolean): Promise<{ ok: boolean; err: string }> {
  let result = await runGitApply(buffer, patch, reverse, check)
  if (!result.ok) {
    const resolvedPatch = await patchWithResolvedFileNames(buffer, patch)
    if (resolvedPatch !== patch) result = await runGitApply(buffer, resolvedPatch, reverse, check)
  }
  return result
}

async function patchWithResolvedFileNames(buffer: BufferModel, patch: string): Promise<string> {
  const lines = patch.split("\n")
  let changed = false
  for (let i = 0; i < lines.length; i++) {
    const gitHeader = /^diff --git\s+(\S+)\s+(\S+)$/.exec(lines[i] ?? "")
    if (gitHeader) {
      const oldFile = cleanPatchHeaderPath(gitHeader[1]!)
      const newFile = cleanPatchHeaderPath(gitHeader[2]!)
      const oldResolved = oldFile && oldFile !== "/dev/null" ? await patchHeaderResolvedPath(buffer, oldFile) : oldFile
      const newResolved = newFile && newFile !== "/dev/null" ? await patchHeaderResolvedPath(buffer, newFile) : newFile
      const next = `diff --git a/${oldResolved} b/${newResolved}`
      if (next !== lines[i]) {
        lines[i] = next
        changed = true
      }
      continue
    }
    const oldHeader = /^---\s+(.+)$/.exec(lines[i] ?? "")
    if (oldHeader) {
      const file = cleanPatchHeaderPath(oldHeader[1]!)
      if (file && file !== "/dev/null") {
        const resolved = await patchHeaderResolvedPath(buffer, file)
        const next = `--- ${resolved}`
        if (next !== lines[i]) {
          lines[i] = next
          changed = true
        }
      }
      continue
    }
    const newHeader = /^\+\+\+\s+(.+)$/.exec(lines[i] ?? "")
    if (newHeader) {
      const file = cleanPatchHeaderPath(newHeader[1]!)
      if (file && file !== "/dev/null") {
        const resolved = await patchHeaderResolvedPath(buffer, file)
        const next = `+++ ${resolved}`
        if (next !== lines[i]) {
          lines[i] = next
          changed = true
        }
      }
    }
  }
  return changed ? lines.join("\n") : patch
}

async function patchHeaderResolvedPath(buffer: BufferModel, file: string): Promise<string> {
  const resolved = await resolveDiffFileName(buffer, file)
  const rel = relative(diffDefaultDirectory(buffer), resolved)
  return rel && !rel.startsWith("..") && !rel.startsWith("/") ? rel : resolved
}

async function runGitApply(buffer: BufferModel, patch: string, reverse: boolean, check: boolean): Promise<{ ok: boolean; err: string }> {
  const args = ["apply", ...(check ? ["--check"] : []), ...(reverse ? ["--reverse"] : []), "-"]
  const proc = spawnProcess({
    cmd: ["git", ...args],
    cwd: diffDefaultDirectory(buffer),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  proc.stdin?.write(patch)
  proc.stdin?.end()
  const err = proc.stderr ? await new Response(proc.stderr).text() : ""
  const code = await proc.exited
  return { ok: code === 0, err }
}

async function killAppliedHunks(buffer: BufferModel): Promise<number> {
  const startLine = buffer.lineAt(buffer.point)
  const matches: DiffHunk[] = []
  for (const file of parseDiffBuffer(buffer)) {
    for (const hunk of file.hunks) {
      if (hunk.startLine < startLine) continue
      const patch = patchForHunk(buffer, file, hunk)
      const reverseApplies = await runGitApplyResolved(buffer, patch, true, true)
      if (reverseApplies.ok) matches.push(hunk)
    }
  }
  for (const hunk of matches.sort((a, b) => b.startLine - a.startLine)) deleteLines(buffer, hunk.startLine, hunk.endLine)
  if (matches.length) buffer.point = Math.min(buffer.point, buffer.text.length)
  return matches.length
}

async function previewPatchedHunk(editor: Editor, buffer: BufferModel): Promise<boolean> {
  const file = diffFileAtPoint(buffer)
  const hunk = diffHunkAtPoint(buffer)
  if (!file || !hunk) return false
  const sourceFile = file.oldFile && file.oldFile !== "/dev/null" ? file.oldFile : file.newFile
  if (!sourceFile || sourceFile === "/dev/null") return false
  const oldStart = hunk.oldStart ?? hunk.newStart
  if (oldStart == null) return false

  const sourcePath = await diffFindFileName(buffer, true) ?? await resolveDiffFileName(buffer, sourceFile)
  const source = await editor.openFile(sourcePath)
  const patchedText = replaceSourceTextRange(source.text, oldStart, hunk.oldCount ?? 0, hunkAppliedText(buffer, hunk, true))
  const preview = editor.scratch(`*diff-ediff-patch: ${sourceFile}*`, patchedText, source.mode)
  preview.readOnly = true
  preview.locals.set("diff-ediff-source", source.path ?? sourceFile)
  editor.switchToBuffer(source.id)
  editor.displayBufferInOtherWindow(preview.id)
  editor.message(`Prepared patched preview for ${sourceFile}`)
  return true
}

function replaceSourceTextRange(sourceText: string, startLine: number, oldCount: number, replacementText: string): string {
  const lines = sourceText.split("\n")
  const replacement = replacementText.endsWith("\n")
    ? replacementText.slice(0, -1).split("\n")
    : replacementText.length
      ? replacementText.split("\n")
      : []
  lines.splice(Math.max(0, startLine - 1), Math.max(0, oldCount), ...replacement)
  return lines.join("\n")
}

async function addChangeLogEntriesOtherWindow(editor: Editor, buffer: BufferModel): Promise<boolean> {
  const entries = changeLogEntries(buffer)
  if (!entries.length) return false
  const path = resolve(diffDefaultDirectory(buffer), "ChangeLog")
  const origin = buffer.id
  const changeLog = await editor.openFile(path)
  const header = `${new Date().toISOString().slice(0, 10)}  ${changeLogUserName()}\n\n`
  const body = entries.map(entry => `\t* ${entry.file}${entry.functionName ? ` (${entry.functionName})` : ""}: \n`).join("")
  const insert = `${header}${body}\n`
  changeLog.setText(insert + changeLog.text, true)
  changeLog.point = insert.length - 1
  if (editor.buffers.has(origin)) editor.switchToBuffer(origin)
  editor.displayBufferInOtherWindow(changeLog.id)
  editor.message(`Added ${entries.length} ChangeLog entr${entries.length === 1 ? "y" : "ies"}`)
  return true
}

function changeLogEntries(buffer: BufferModel): Array<{ file: string; functionName?: string }> {
  return diffAddLogCurrentDefuns(buffer).flatMap(entry => {
    if (!entry.defuns.length) return [{ file: entry.file }]
    return entry.defuns.map(functionName => ({ file: entry.file, functionName }))
  })
}

function diffCurrentDefun(buffer: BufferModel): string | undefined {
  const hunk = diffHunkAtPoint(buffer)
  if (!hunk) return undefined
  return hunkFunctionName(lineInfo(buffer)[hunk.startLine]?.text ?? "")
}

function diffAddLogCurrentDefuns(buffer: BufferModel): Array<{ file: string; defuns: string[] }> {
  const entries: Array<{ file: string; functionName?: string }> = []
  const seen = new Set<string>()
  const lines = lineInfo(buffer)
  for (const file of parseDiffBuffer(buffer)) {
    const name = file.newFile && file.newFile !== "/dev/null" ? file.newFile : file.oldFile
    if (!name || name === "/dev/null") continue
    for (const hunk of file.hunks) {
      const functionName = hunkFunctionName(lines[hunk.startLine]?.text ?? "")
      const key = `${name}\0${functionName ?? ""}`
      if (seen.has(key)) continue
      seen.add(key)
      entries.push({ file: name, functionName })
    }
  }
  const grouped: Array<{ file: string; defuns: string[] }> = []
  for (const entry of entries) {
    const existing = grouped.find(item => item.file === entry.file)
    if (existing) {
      if (entry.functionName && !existing.defuns.includes(entry.functionName)) existing.defuns.push(entry.functionName)
    } else {
      grouped.push({ file: entry.file, defuns: entry.functionName ? [entry.functionName] : [] })
    }
  }
  return grouped
}

function hunkFunctionName(header: string): string | undefined {
  const unified = /^@@\s+-.+?\s+\+.+?\s+@@\s*(.+?)\s*$/.exec(header)?.[1]
  if (unified) return unified
  return undefined
}

function changeLogUserName(): string {
  const name = process.env.GIT_AUTHOR_NAME || process.env.USER || process.env.LOGNAME || "user"
  const email = process.env.GIT_AUTHOR_EMAIL || process.env.EMAIL
  return email ? `${name}  <${email}>` : name
}

function reverseDiffDirection(buffer: BufferModel): void {
  const next = lineInfo(buffer).map(line => {
    const text = line.text
    const git = /^diff --git a\/(.+) b\/(.+)$/.exec(text)
    if (git) return `diff --git a/${git[2]} b/${git[1]}`
    if (text.startsWith("--- ")) return "+++ " + text.slice(4)
    if (text.startsWith("+++ ")) return "--- " + text.slice(4)
    if (text.startsWith("*** ")) return "--- " + text.slice(4)
    const unified = /^@@\s+-(\d+(?:,\d+)?)\s+\+(\d+(?:,\d+)?)\s+@@(.*)$/.exec(text)
    if (unified) return `@@ -${unified[2]} +${unified[1]} @@${unified[3]}`
    if (text.startsWith("+")) return "-" + text.slice(1)
    if (text.startsWith("-")) return "+" + text.slice(1)
    if (text.startsWith("new file mode ")) return text.replace(/^new/, "deleted")
    if (text.startsWith("deleted file mode ")) return text.replace(/^deleted/, "new")
    return text
  }).join("\n")
  buffer.setText(next)
}

function isUnifiedBodyLine(line: string): boolean {
  return line.startsWith(" ") || line.startsWith("+") || line.startsWith("-") || line.startsWith("\\")
}

function countUnifiedLines(lines: string[], side: "old" | "new"): number {
  return lines.filter(line => {
    if (line.startsWith("\\")) return false
    if (line.startsWith(" ")) return true
    return side === "old" ? line.startsWith("-") : line.startsWith("+")
  }).length
}

function formatUnifiedHeader(oldStart: number, oldCount: number, newStart: number, newCount: number, suffix: string): string {
  return `@@ -${formatRange(oldStart, oldCount)} +${formatRange(newStart, newCount)} @@${suffix}`
}

function formatRange(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`
}

function deleteLines(buffer: BufferModel, startLine: number, endLine: number): void {
  const lines = lineInfo(buffer)
  const start = lines[startLine]?.start ?? 0
  const end = endLine + 1 < lines.length ? lines[endLine + 1]!.start : buffer.text.length
  buffer.deleteRange(start, end)
}

function killCreationsDeletions(buffer: BufferModel): number {
  const matches = parseDiffBuffer(buffer).filter(file => file.oldFile === "/dev/null" || file.newFile === "/dev/null")
  for (const file of matches.sort((a, b) => b.startLine - a.startLine)) deleteLines(buffer, file.startLine, file.endLine)
  if (matches.length) buffer.point = Math.min(buffer.point, buffer.text.length)
  return matches.length
}

function killJunk(buffer: BufferModel): number {
  const lines = lineInfo(buffer)
  const ranges: Array<{ startLine: number; endLine: number }> = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]?.text.startsWith("Index: ")) continue
    let j = i + 1
    while (j < lines.length && !isJunkTerminator(lines[j]!.text)) j++
    if (j >= lines.length) continue
    if (lines[j]!.text.startsWith("Index: ")) ranges.push({ startLine: i, endLine: j - 1 })
    else if (j > i + 1) ranges.push({ startLine: i + 1, endLine: j - 1 })
  }
  for (const range of ranges.sort((a, b) => b.startLine - a.startLine)) deleteLines(buffer, range.startLine, range.endLine)
  if (ranges.length) buffer.point = Math.min(buffer.point, buffer.text.length)
  return ranges.length
}

async function diffDeleteIfEmpty(buffer: BufferModel): Promise<boolean> {
  if (!buffer.path) return false
  try {
    const info = await stat(buffer.path)
    if (info.size !== 0) return false
    await rm(buffer.path, { force: true })
    return true
  } catch {
    return false
  }
}

async function diffDeleteEmptyFilesAfterSave({ buffer }: { buffer: BufferModel }): Promise<void> {
  if (buffer.locals.get(DIFF_DELETE_EMPTY_FILES_LOCAL)) await diffDeleteIfEmpty(buffer)
}

async function deleteTrailingWhitespaceFromDiff(editor: Editor, buffer: BufferModel, otherFile: boolean): Promise<number> {
  const edits: Array<{ line: number; file: string; sourceLine: number }> = []
  const lines = lineInfo(buffer)
  for (const file of parseDiffBuffer(buffer)) {
    for (const hunk of file.hunks) {
      edits.push(...trailingWhitespaceEdits(buffer, lines, file, hunk, otherFile))
    }
  }
  for (const edit of edits.sort((a, b) => b.line - a.line)) {
    const line = lines[edit.line]
    if (!line) continue
    const next = line.text.replace(/[ \t]+$/, "")
    buffer.splice(line.start, line.end, next, { markDirty: true })
  }
  const byFile = new Map<string, number[]>()
  for (const edit of edits) byFile.set(edit.file, [...(byFile.get(edit.file) ?? []), edit.sourceLine])
  for (const [file, sourceLines] of byFile) {
    const source = await editor.openFile(await resolveDiffFileName(buffer, file))
    trimTrailingWhitespaceAtLines(source, sourceLines)
  }
  return edits.length
}

function trailingWhitespaceEdits(
  buffer: BufferModel,
  lines: Line[],
  file: DiffFile,
  hunk: DiffHunk,
  otherFile: boolean,
): Array<{ line: number; file: string; sourceLine: number }> {
  if (hunk.style === "unified") return unifiedTrailingWhitespaceEdits(lines, file, hunk, otherFile)
  if (hunk.style === "context") return contextTrailingWhitespaceEdits(buffer, lines, file, hunk, otherFile)
  return []
}

function unifiedTrailingWhitespaceEdits(
  lines: Line[],
  file: DiffFile,
  hunk: DiffHunk,
  otherFile: boolean,
): Array<{ line: number; file: string; sourceLine: number }> {
  const targetFile = otherFile ? file.oldFile : file.newFile
  if (!targetFile || targetFile === "/dev/null") return []
  const edits: Array<{ line: number; file: string; sourceLine: number }> = []
  let oldLine = hunk.oldStart ?? 1
  let newLine = hunk.newStart ?? 1
  for (let i = hunk.startLine + 1; i <= hunk.endLine; i++) {
    const text = lines[i]?.text ?? ""
    if (text.startsWith("\\")) continue
    const lineNumber = otherFile ? oldLine : newLine
    const matchesSide = otherFile ? text.startsWith("-") : text.startsWith("+")
    if (matchesSide && /[ \t]+$/.test(text)) edits.push({ line: i, file: targetFile, sourceLine: lineNumber })
    if (!text.startsWith("+")) oldLine++
    if (!text.startsWith("-")) newLine++
  }
  return edits
}

function contextTrailingWhitespaceEdits(
  buffer: BufferModel,
  lines: Line[],
  file: DiffFile,
  hunk: DiffHunk,
  otherFile: boolean,
): Array<{ line: number; file: string; sourceLine: number }> {
  const targetFile = otherFile ? file.oldFile : file.newFile
  if (!targetFile || targetFile === "/dev/null") return []
  const edits: Array<{ line: number; file: string; sourceLine: number }> = []
  const hunkLines = lines.slice(hunk.startLine + 1, hunk.endLine + 1)
  const middle = hunkLines.findIndex(line => /^--- \d/.test(line.text))
  if (middle < 0) return edits
  const half = otherFile ? hunkLines.slice(0, middle) : hunkLines.slice(middle + 1)
  let lineNumber = otherFile ? hunk.oldStart ?? 1 : hunk.newStart ?? 1
  for (const line of half) {
    const text = line.text
    if (/^\*{15}/.test(text) || /^\*\*\* \d/.test(text) || /^--- \d/.test(text)) continue
    const changed = otherFile ? text.startsWith("- ") || text.startsWith("! ") : text.startsWith("+ ") || text.startsWith("! ")
    if (changed && /[ \t]+$/.test(text)) edits.push({ line: buffer.lineAt(line.start), file: targetFile, sourceLine: lineNumber })
    if (/^[ !+-] /.test(text)) lineNumber++
  }
  return edits
}

function trimTrailingWhitespaceAtLines(buffer: BufferModel, lineNumbers: number[]): void {
  const unique = [...new Set(lineNumbers)].sort((a, b) => b - a)
  const lines = lineInfo(buffer)
  for (const lineNumber of unique) {
    const line = lines[lineNumber - 1]
    if (!line || !/[ \t]+$/.test(line.text)) continue
    buffer.splice(line.start, line.end, line.text.replace(/[ \t]+$/, ""), { markDirty: true })
  }
}

function diffDefaultDirectory(buffer: BufferModel): string {
  const local = buffer.locals.get("diff-default-directory") as string | undefined
  return local ?? buffer.directory() ?? process.cwd()
}

async function resolveDiffFileName(buffer: BufferModel, file: string): Promise<string> {
  return resolveDiffFileCandidates(buffer, [file])
}

async function diffFindFileName(buffer: BufferModel, old: boolean): Promise<string | null> {
  const candidates = diffHunkFileNames(buffer, old)
  if (!candidates.length) return null
  const remembered = rememberedDiffFiles(buffer).get(diffRememberKey(candidates))
  if (remembered) return resolve(diffDefaultDirectory(buffer), remembered)
  return resolveDiffFileCandidates(buffer, candidates)
}

async function diffBufferFileNames(buffer: BufferModel, old: boolean): Promise<string[]> {
  const found: string[] = []
  const originalPoint = buffer.point
  try {
    for (const file of parseDiffBuffer(buffer)) {
      const line = lineInfo(buffer)[file.startLine]
      if (!line) continue
      buffer.point = line.start
      const resolved = await diffFindFileName(buffer, old)
      if (resolved && !found.includes(resolved)) found.push(resolved)
    }
  } finally {
    buffer.point = originalPoint
  }
  return found
}

function rememberDiffFileName(buffer: BufferModel, old: boolean, name: string): boolean {
  const candidates = diffHunkFileNames(buffer, old)
  if (!candidates.length) return false
  rememberedDiffFiles(buffer).set(diffRememberKey(candidates), name)
  return true
}

function rememberedDiffFiles(buffer: BufferModel): Map<string, string> {
  let remembered = buffer.locals.get(DIFF_REMEMBERED_FILES_LOCAL) as Map<string, string> | undefined
  if (!remembered) {
    remembered = new Map()
    buffer.locals.set(DIFF_REMEMBERED_FILES_LOCAL, remembered)
  }
  return remembered
}

function diffRememberKey(candidates: string[]): string {
  return candidates.join("\0")
}

function diffHunkFileNames(buffer: BufferModel, old: boolean): string[] {
  const file = diffFileAtPoint(buffer)
  if (!file) return []
  const primary = old ? file.oldFile : file.newFile
  const secondary = old ? file.newFile : file.oldFile
  return [primary, secondary].filter((name): name is string => Boolean(name && name !== "/dev/null"))
}

async function resolveDiffFileCandidates(buffer: BufferModel, files: string[]): Promise<string> {
  const dir = diffDefaultDirectory(buffer)
  for (const file of files) {
    for (const candidate of diffPathCandidates(file)) {
      const path = resolve(dir, candidate)
      if (await isRegularFile(path)) return path
    }
  }
  return resolve(dir, files[0] ?? "")
}

function diffPathCandidates(file: string): string[] {
  const out: string[] = []
  let candidate = cleanDiffPath(file)
  while (candidate && candidate !== "/dev/null") {
    out.push(candidate)
    const next = candidate.replace(/^[^/\\]+[/\\]/, "")
    if (next === candidate) break
    candidate = next
  }
  return out
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function cleanDiffPath(path: string): string {
  const trimmed = path.trim()
  if (trimmed === "/dev/null") return trimmed
  return trimmed.replace(/^[ab]\//, "")
}

function cleanPatchHeaderPath(path: string): string {
  const raw = path.trim()
  if (raw === "/dev/null") return raw
  return cleanDiffPath(raw.split(/\t| \d/)[0] ?? raw)
}

function isHunkBodyLine(text: string, style: DiffHunkStyle): boolean {
  if (style === "unified") return isUnifiedBodyLine(text)
  if (style === "normal") return /^[<>] /.test(text) || /^---$/.test(text)
  return /^(  |! |\+ |- |--- )/.test(text)
}

function isJunkTerminator(text: string): boolean {
  return text.startsWith("Index: ")
    || text.startsWith("diff --git ")
    || /^(---|\+\+\+|\*\*\*) /.test(text)
    || /^Only in /.test(text)
    || /^Binary files .* differ$/.test(text)
}

function lineInfo(buffer: BufferModel): Line[] {
  const lines: Line[] = []
  for (let i = 0; i < buffer.lineCount; i++) {
    const [start, end] = buffer.lineBounds(i)
    lines.push({ text: buffer.text.slice(start, end), start, end })
  }
  return lines
}

function textLines(text: string): Line[] {
  const lines: Line[] = []
  let start = 0
  for (const part of text.split("\n")) {
    const end = start + part.length
    lines.push({ text: part, start, end })
    start = end + 1
  }
  return lines
}

function prefixCount(prefix: unknown): number {
  if (typeof prefix === "number" && Number.isFinite(prefix)) return Math.trunc(Math.abs(prefix))
  return 1
}

function findLastIndex<T>(items: T[], pred: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (pred(items[i]!)) return i
  return -1
}
