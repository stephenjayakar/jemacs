import { readdir, readFile, realpath, unlink, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { basename, isAbsolute, join, relative } from "node:path"
import { tmpdir } from "node:os"
import type { Editor, TransientDefinition } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { BufferModel } from "../../src/kernel/buffer"
import { defineMode, modeLineage, type FontLockRange, type TextSpan } from "../../src/modes/mode"
import { Keymap } from "../../src/kernel/keymap"
import { nextWindowId } from "../../src/kernel/window"
import { spawnProcess } from "../../src/platform/runtime"
import { diffFontLockText } from "../../src/modes/diff"
import { defcustom, getCustom } from "../../src/runtime/custom"
import { projectRoot } from "../project"
import { BLAME_SHAS_LOCAL, blameChunkTarget, blameShaAtPoint, parseBlamePorcelain, renderBlame } from "./blame"
import { parseBisectOutput } from "./bisect"
import {
  changeTodoActionAtPoint,
  moveTodoLine,
  parseGitLogForRebaseTodo,
  runInteractiveRebaseTodo,
  type RebaseTodoAction,
} from "./rebase-todo"
import { appendProcessEntry, openProcessBuffer, runGitLogged, type MagitGitResult } from "./process"
import {
  MAGIT_SECTION_VISIBILITY_CACHE_LOCAL,
  MagitSectionBuilder,
  currentSection,
  installMagitSection,
  setRootSection,
  visibilityCache,
  type MagitSection,
  type MagitSectionVisibility,
} from "./section"
import {
  WITH_EDITOR_AWAIT_ON_FINISH_LOCAL,
  WITH_EDITOR_PROCESS_LOCAL,
  abortWithEditorBuffer,
  acceptWithEditorBuffer,
  createWithEditorSession,
  gitCommitFontLock,
  gitCommitMessageBody,
  isWithEditorBuffer,
  openWithEditorBuffer,
  type WithEditorSession,
} from "./with-editor"

/** A file-level section in the status buffer; line ranges let s/u act on the diff body too. */
export type MagitEntry = {
  file: string
  oldFile?: string
  staged: boolean
  untracked: boolean
  conflicted?: boolean
  startLine: number
  endLine: number
}

/** One @@-hunk's range in the status buffer plus a self-contained patch for `git apply --cached`. */
export type MagitHunk = {
  file: string
  oldFile?: string
  staged: boolean
  startLine: number
  endLine: number
  patch: string
}

type MagitHistoryMark = { bufferId: string; point: number }
type MagitRefKind = "local" | "remote" | "tag"
type MagitRef = {
  name: string
  fullName: string
  kind: MagitRefKind
  remote?: string
  current?: boolean
  sha?: string
  summary?: string
  upstream?: string
  ahead?: number
  behind?: number
}
type MagitModule = { name: string; path: string; url?: string }
type MagitWorktree = { path: string; head?: string; branch?: string; current?: boolean; bare?: boolean; detached?: boolean }

/** Reject names that would be parsed as a flag by git. */
function refname(s: string): string {
  if (s.startsWith("-")) throw new Error(`invalid ref/remote name: ${s}`)
  return s
}

export function magitCommitRewordArgs(): string[] {
  return ["commit", "--amend", "--only"]
}

export function magitCommitFixupArgs(target: string): string[] {
  return ["commit", `--fixup=${refname(target)}`]
}

export function magitCommitSquashArgs(target: string): string[] {
  return ["commit", `--squash=${refname(target)}`]
}

export function magitRebaseInteractiveArgs(base: string): string[] {
  return ["rebase", "-i", "--autosquash", refname(base)]
}

async function git(
  args: string[],
  cwd: string,
  stdin?: string,
  env?: Record<string, string>,
  editor?: Editor,
): Promise<{ out: string; err: string; code: number | null }> {
  return runGitLogged(args, cwd, { stdin, env, editor })
}

type FileChange = { file: string; xy: string; oldFile?: string; unmerged?: boolean }

/** Minimal porcelain=v2 reader: just the XY state and path of ordinary/renamed/untracked entries. */
export function parsePorcelain(out: string): { branch: string | null; upstream: string | null; files: FileChange[] } {
  let branch: string | null = null
  let upstream: string | null = null
  const files: FileChange[] = []
  for (const line of out.split("\n")) {
    if (!line) continue
    if (line.startsWith("# branch.head ")) branch = line.slice("# branch.head ".length)
    else if (line.startsWith("# branch.upstream ")) upstream = line.slice("# branch.upstream ".length)
    else if (line.startsWith("1 ")) {
      const parts = line.split(" ")
      const xy = parts[1] ?? ".."
      const file = parts.slice(8).join(" ")
      if (file) files.push({ file, xy })
    } else if (line.startsWith("2 ")) {
      const tab = line.indexOf("\t")
      const beforeTab = tab >= 0 ? line.slice(0, tab) : line
      const parts = beforeTab.split(" ")
      const xy = parts[1] ?? ".."
      const file = parts.slice(9).join(" ")
      const oldFile = tab >= 0 ? line.slice(tab + 1) : undefined
      if (file) files.push(oldFile ? { file, oldFile, xy } : { file, xy })
    } else if (line.startsWith("u ")) {
      const parts = line.split(" ")
      const xy = parts[1] ?? "UU"
      const file = parts.slice(10).join(" ")
      if (file) files.push({ file, xy, unmerged: true })
    } else if (line.startsWith("? ")) {
      files.push({ file: line.slice(2), xy: "??" })
    }
  }
  return { branch, upstream, files }
}

function changeLabel(code: string): string {
  switch (code) {
    case "M": return "modified  "
    case "A": return "new file  "
    case "D": return "deleted   "
    case "R": return "renamed  "
    case "?": return "untracked "
    case "U": return "unmerged  "
    default: return "modified  "
  }
}

export type DiffHunk = { header: string; lines: string[] }
export type FileDiff = { file: string; header: string[]; hunks: DiffHunk[] }
type HunkHeader = {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  suffix: string
}
type TextLine = { text: string; start: number; end: number; index: number }

/** Split `git diff` output into per-file headers and per-hunk bodies, preserving enough to rebuild a patch. */
export function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = []
  let cur: FileDiff | null = null
  let hunk: DiffHunk | null = null
  for (const line of diff.split("\n")) {
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    if (m) {
      cur = { file: m[2]!, header: [line], hunks: [] }
      files.push(cur)
      hunk = null
      continue
    }
    if (!cur) continue
    if (line.startsWith("@@")) {
      hunk = { header: line, lines: [] }
      cur.hunks.push(hunk)
    } else if (hunk && (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-") || line.startsWith("\\"))) {
      hunk.lines.push(line)
    } else if (!hunk) {
      cur.header.push(line)
    }
  }
  return files
}

function hunkPatch(fd: FileDiff, h: DiffHunk): string {
  return [...fd.header, h.header, ...h.lines, ""].join("\n")
}

function parseHunkHeader(header: string): HunkHeader | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(header)
  if (!m) return null
  return {
    oldStart: Number(m[1]),
    oldCount: m[2] == null ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newCount: m[4] == null ? 1 : Number(m[4]),
    suffix: m[5] ?? "",
  }
}

function formatHunkHeader(header: HunkHeader, oldCount: number, newCount: number): string {
  const oldRange = oldCount === 1 ? String(header.oldStart) : `${header.oldStart},${oldCount}`
  const newRange = newCount === 1 ? String(header.newStart) : `${header.newStart},${newCount}`
  return `@@ -${oldRange} +${newRange} @@${header.suffix}`
}

function lineInfos(text: string): TextLine[] {
  const lines: TextLine[] = []
  let start = 0
  let index = 0
  while (start <= text.length) {
    const newline = text.indexOf("\n", start)
    const end = newline < 0 ? text.length : newline
    lines.push({ text: text.slice(start, end), start, end, index })
    if (newline < 0) break
    start = newline + 1
    index++
    if (start === text.length) break
  }
  return lines
}

function countHunkLine(line: string, side: "old" | "new"): boolean {
  if (line.startsWith("\\")) return false
  if (line.startsWith(" ")) return true
  if (side === "old") return line.startsWith("-")
  return line.startsWith("+")
}

function effectiveSelectedHunkLines(lines: string[], selectedBodyLines: ReadonlySet<number>): Set<number> {
  const selected = new Set(selectedBodyLines)
  let i = 0
  while (i < lines.length) {
    if (!lines[i]?.startsWith("-")) {
      i++
      continue
    }
    const removed: number[] = []
    while (i < lines.length && lines[i]?.startsWith("-")) removed.push(i++)
    const between = i
    while (i < lines.length && lines[i]?.startsWith("\\")) i++
    const added: number[] = []
    while (i < lines.length && lines[i]?.startsWith("+")) added.push(i++)
    if (!added.length) continue
    if (removed.length === added.length) {
      for (let n = 0; n < removed.length; n++) {
        const r = removed[n]!
        const a = added[n]!
        if (selected.has(r) || selected.has(a)) {
          selected.add(r)
          selected.add(a)
        }
      }
    } else if ([...removed, ...added].some(index => selected.has(index))) {
      for (const index of [...removed, ...added]) selected.add(index)
    }
    if (between !== i) {
      // No-newline markers annotate the changed line immediately before them.
      // They are kept later only when that changed line survives the partial hunk.
    }
  }
  return selected
}

function transformPartialHunkBody(body: string[], selected: ReadonlySet<number>): string[] {
  const out: string[] = []
  for (let i = 0; i < body.length; i++) {
    const line = body[i]!
    if (line.startsWith("-")) {
      const removed: Array<{ index: number; line: string }> = []
      while (i < body.length && body[i]?.startsWith("-")) {
        removed.push({ index: i, line: body[i]! })
        i++
      }
      while (i < body.length && body[i]?.startsWith("\\")) i++
      const added: Array<{ index: number; line: string }> = []
      while (i < body.length && body[i]?.startsWith("+")) {
        added.push({ index: i, line: body[i]! })
        i++
      }
      i--
      if (added.length && removed.length === added.length) {
        for (let n = 0; n < removed.length; n++) {
          const r = removed[n]!
          const a = added[n]!
          if (selected.has(r.index) || selected.has(a.index)) {
            out.push(r.line, a.line)
          } else {
            out.push(` ${r.line.slice(1)}`)
          }
        }
      } else if (added.length) {
        const wholeBlock = [...removed, ...added].some(entry => selected.has(entry.index))
        if (wholeBlock) out.push(...removed.map(entry => entry.line), ...added.map(entry => entry.line))
        else out.push(...removed.map(entry => ` ${entry.line.slice(1)}`))
      } else {
        for (const r of removed) out.push(selected.has(r.index) ? r.line : ` ${r.line.slice(1)}`)
      }
      continue
    }
    if (line.startsWith("+")) {
      if (selected.has(i)) out.push(line)
      continue
    }
    if (line.startsWith("\\")) {
      const prev = out[out.length - 1]
      if (prev?.startsWith("+") || prev?.startsWith("-")) out.push(line)
      continue
    }
    out.push(line)
  }
  return out
}

export function partialHunkPatch(patch: string, selectedBodyLines: Iterable<number>): string | null {
  const raw = patch.endsWith("\n") ? patch.slice(0, -1) : patch
  const lines = raw.split("\n")
  const hunkIndex = lines.findIndex(line => line.startsWith("@@"))
  if (hunkIndex < 0) return null
  const parsed = parseHunkHeader(lines[hunkIndex]!)
  if (!parsed) return null
  const body = lines.slice(hunkIndex + 1)
  const selected = effectiveSelectedHunkLines(body, new Set(selectedBodyLines))
  const selectedChanged = [...selected].some(index => body[index]?.startsWith("+") || body[index]?.startsWith("-"))
  if (!selectedChanged) return null

  const outBody = transformPartialHunkBody(body, selected)

  const oldCount = outBody.filter(line => countHunkLine(line, "old")).length
  const newCount = outBody.filter(line => countHunkLine(line, "new")).length
  const next = [
    ...lines.slice(0, hunkIndex),
    formatHunkHeader(parsed, oldCount, newCount),
    ...outBody,
    "",
  ]
  return next.join("\n")
}

function selectedHunkBodyLines(buffer: BufferModel, hunk: MagitHunk): number[] | null {
  if (!buffer.useRegion()) return null
  const section = sectionOfType(buffer, "hunk")
  if (section && section.value !== hunk) return null
  const start = Math.min(buffer.mark!, buffer.point)
  const end = Math.max(buffer.mark!, buffer.point)
  const lines = hunk.patch.split("\n")
  const hunkHeaderIndex = lines.findIndex(line => line.startsWith("@@"))
  if (hunkHeaderIndex < 0) return null
  const bodyLineCount = lines.length - hunkHeaderIndex - 2
  const selected: number[] = []
  for (let i = 0; i < bodyLineCount; i++) {
    const bufferLine = hunk.startLine + 1 + i
    if (bufferLine < 0 || bufferLine >= buffer.lineCount) continue
    const [lineStart, lineEndNoNewline] = buffer.lineBounds(bufferLine)
    const lineEnd = Math.min(buffer.text.length, lineEndNoNewline + 1)
    if (lineEnd > start && lineStart < end) selected.push(i)
  }
  return selected.length ? selected : null
}

function partialPatchForRegion(buffer: BufferModel, hunk: MagitHunk): string | null {
  const selected = selectedHunkBodyLines(buffer, hunk)
  return selected ? partialHunkPatch(hunk.patch, selected) : null
}

type Token = { text: string; start: number; end: number }

function wordTokens(text: string): Token[] {
  const tokens: Token[] = []
  const re = /[A-Za-z0-9_]+|\s+|[^A-Za-z0-9_\s]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length })
  return tokens
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

function tokenChangedRanges(oldText: string, newText: string): Array<[number, number, number, number]> {
  const oldTokens = wordTokens(oldText)
  const newTokens = wordTokens(newText)
  if (!oldTokens.length || !newTokens.length) return [changedSubstringBounds(oldText, newText)]
  const dp: number[][] = Array.from({ length: oldTokens.length + 1 }, () => Array(newTokens.length + 1).fill(0))
  for (let i = oldTokens.length - 1; i >= 0; i--) {
    for (let j = newTokens.length - 1; j >= 0; j--) {
      dp[i]![j] = oldTokens[i]!.text === newTokens[j]!.text
        ? dp[i + 1]![j + 1]! + 1
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < oldTokens.length && j < newTokens.length) {
    if (oldTokens[i]!.text === newTokens[j]!.text) {
      pairs.push([i, j])
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++
    else j++
  }
  const ranges: Array<[number, number, number, number]> = []
  let oldCursor = 0
  let newCursor = 0
  for (const [oldIndex, newIndex] of pairs) {
    const oldToken = oldTokens[oldIndex]!
    const newToken = newTokens[newIndex]!
    if (oldCursor < oldToken.start || newCursor < newToken.start) {
      ranges.push([oldCursor, oldToken.start, newCursor, newToken.start])
    }
    oldCursor = oldToken.end
    newCursor = newToken.end
  }
  if (oldCursor < oldText.length || newCursor < newText.length) ranges.push([oldCursor, oldText.length, newCursor, newText.length])
  return ranges.filter(([oldStart, oldEnd, newStart, newEnd]) => oldStart < oldEnd || newStart < newEnd)
}

function refineLinePairs(removed: TextLine[], added: TextLine[], prefixLen: number, spans: TextSpan[]): void {
  const n = Math.min(removed.length, added.length)
  for (let i = 0; i < n; i++) {
    const r = removed[i]!
    const a = added[i]!
    const oldText = r.text.slice(prefixLen)
    const newText = a.text.slice(prefixLen)
    for (const [oldStart, oldEnd, newStart, newEnd] of tokenChangedRanges(oldText, newText)) {
      if (oldStart < oldEnd) spans.push({ start: r.start + prefixLen + oldStart, end: r.start + prefixLen + oldEnd, face: "diffRefineRemoved" })
      if (newStart < newEnd) spans.push({ start: a.start + prefixLen + newStart, end: a.start + prefixLen + newEnd, face: "diffRefineAdded" })
    }
  }
  for (const r of removed.slice(n)) {
    if (r.text.length > prefixLen) spans.push({ start: r.start + prefixLen, end: r.end, face: "diffRefineRemoved" })
  }
  for (const a of added.slice(n)) {
    if (a.text.length > prefixLen) spans.push({ start: a.start + prefixLen, end: a.end, face: "diffRefineAdded" })
  }
}

function unifiedHunkRanges(lines: TextLine[]): Array<{ startLine: number; endLine: number; start: number; end: number }> {
  const ranges: Array<{ startLine: number; endLine: number; start: number; end: number }> = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.text.startsWith("@@")) continue
    let endLine = lines.length - 1
    for (let j = i + 1; j < lines.length; j++) {
      const text = lines[j]!.text
      if (text.startsWith("@@") || text.startsWith("diff --git ")) {
        endLine = j - 1
        break
      }
    }
    ranges.push({ startLine: i, endLine, start: lines[i]!.start, end: lines[endLine]?.end ?? lines[i]!.end })
  }
  return ranges
}

export function magitDiffRefineSpans(text: string, options: { point?: number; all?: boolean; offset?: number } = {}): TextSpan[] {
  const offset = options.offset ?? 0
  const lines = lineInfos(text)
  const ranges = unifiedHunkRanges(lines)
    .filter(range => options.all || options.point == null || (options.point >= range.start && options.point <= range.end))
  const spans: TextSpan[] = []
  for (const range of ranges) {
    for (let i = range.startLine + 1; i <= range.endLine; i++) {
      if (!lines[i]?.text.startsWith("-")) continue
      const removed: TextLine[] = []
      while (i <= range.endLine && lines[i]?.text.startsWith("-")) removed.push(lines[i++]!)
      while (i <= range.endLine && lines[i]?.text.startsWith("\\")) i++
      const added: TextLine[] = []
      while (i <= range.endLine && lines[i]?.text.startsWith("+")) added.push(lines[i++]!)
      i--
      refineLinePairs(removed, added, 1, spans)
    }
  }
  return offset ? spans.map(span => ({ ...span, start: span.start + offset, end: span.end + offset })) : spans
}

function statusHeader(label: string, value: string): string {
  return `${label.padEnd(10)}${value}\n`
}

function trimOrNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

async function gitString(args: string[], root: string, editor?: Editor): Promise<string | null> {
  const { out, code } = await git(args, root, undefined, undefined, editor)
  return code === 0 ? trimOrNull(out) : null
}

async function gitConfig(root: string, key: string, editor?: Editor): Promise<string | null> {
  return gitString(["config", "--get", key], root, editor)
}

async function revisionSummary(root: string, rev: string, editor?: Editor): Promise<string | null> {
  const summary = await gitString(["log", "-1", "--pretty=%s", rev], root, editor)
  return summary ?? null
}

async function revisionLine(root: string, rev: string, editor?: Editor): Promise<string | null> {
  return gitString(["log", "-1", "--pretty=%h %s", rev], root, editor)
}

async function shortRevision(root: string, rev: string, editor?: Editor): Promise<string> {
  return (await gitString(["rev-parse", "--short", rev], root, editor)) ?? rev.slice(0, 7)
}

function shortenRefName(ref: string): string {
  return ref
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "")
    .replace(/\^0$/, "")
}

function parseForEachRef(text: string, kind: MagitRefKind, options: { remote?: string; current?: string | null } = {}): MagitRef[] {
  const refs: MagitRef[] = []
  for (const line of text.split("\n")) {
    if (!line) continue
    const [fullName = "", name = "", sha = "", upstream = "", summary = ""] = line.split("\0")
    if (!fullName || !name || fullName.endsWith("/HEAD")) continue
    refs.push({
      fullName,
      name,
      kind,
      remote: options.remote,
      current: kind === "local" && name === options.current,
      sha,
      upstream: upstream || undefined,
      summary,
    })
  }
  return refs
}

function parseWorktreeList(text: string): MagitWorktree[] {
  const worktrees: MagitWorktree[] = []
  let current: MagitWorktree | null = null
  const finish = () => {
    if (!current) return
    worktrees.push(current)
    current = null
  }
  for (const line of text.split("\n")) {
    if (!line) {
      finish()
      continue
    }
    if (line.startsWith("worktree ")) {
      finish()
      current = { path: line.slice("worktree ".length) }
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length)
    } else if (current && line.startsWith("branch ")) {
      current.branch = shortenRefName(line.slice("branch ".length))
    } else if (current && line === "bare") {
      current.bare = true
    } else if (current && line === "detached") {
      current.detached = true
    }
  }
  finish()
  return worktrees
}

function parseGitModulesConfig(text: string): MagitModule[] {
  const byName = new Map<string, MagitModule>()
  for (const line of text.split("\n")) {
    const match = /^submodule\.(.+)\.(path|url)\s+(.+)$/.exec(line)
    if (!match) continue
    const [, name = "", key = "", value = ""] = match
    const module = byName.get(name) ?? { name, path: "" }
    if (key === "path") module.path = value
    else module.url = value
    byName.set(name, module)
  }
  return [...byName.values()].filter(module => module.path).sort((a, b) => a.path.localeCompare(b.path))
}

async function listSubmodules(root: string, editor?: Editor): Promise<MagitModule[]> {
  if (!existsSync(join(root, ".gitmodules"))) return []
  const { out, code } = await git(["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.(path|url)$"], root, undefined, undefined, editor)
  return code === 0 ? parseGitModulesConfig(out) : []
}

async function listWorktrees(root: string, editor?: Editor): Promise<MagitWorktree[]> {
  const { out, code } = await git(["worktree", "list", "--porcelain"], root, undefined, undefined, editor)
  if (code !== 0) return []
  const current = await realpath(root).catch(() => root)
  const worktrees = parseWorktreeList(out)
  return Promise.all(worktrees.map(async worktree => ({
    ...worktree,
    current: await realpath(worktree.path).catch(() => worktree.path) === current,
  })))
}

function worktreeLabel(worktree: MagitWorktree): string {
  const head = worktree.branch ?? (worktree.detached ? "detached" : worktree.head?.slice(0, 7) ?? "unknown")
  return `${worktree.current ? "* " : "  "}${worktree.path} ${head}`
}

async function displayRevName(root: string, rev: string | null, editor?: Editor): Promise<string> {
  if (!rev) return "HEAD"
  if (!/^[0-9a-f]{40}$/.test(rev)) return shortenRefName(rev)
  const name = await gitString(["name-rev", "--name-only", "--no-undefined", rev], root, editor)
  if (name && !name.includes("undefined")) return shortenRefName(name)
  return shortRevision(root, rev, editor)
}

async function upstreamHeaderLabel(root: string, branch: string | null, editor?: Editor): Promise<"Merge:" | "Rebase:"> {
  if (!branch || branch === "(detached)") return "Merge:"
  const branchRebase = await gitConfig(root, `branch.${branch}.rebase`, editor)
  if (branchRebase === "false") return "Merge:"
  if (branchRebase) return "Rebase:"
  const pullRebase = await gitConfig(root, "pull.rebase", editor)
  return pullRebase && pullRebase !== "false" ? "Rebase:" : "Merge:"
}

async function pushBranchTarget(root: string, branch: string | null, editor?: Editor): Promise<string | null> {
  if (!branch || branch === "(detached)") return null
  const remote = await gitConfig(root, `branch.${branch}.pushRemote`, editor)
    ?? await gitConfig(root, "remote.pushDefault", editor)
  if (!remote) return null
  const target = await gitString(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{push}"], root, editor)
  return target ? shortenRefName(target) : `${remote}/${branch}`
}

async function describedTag(root: string, editor?: Editor): Promise<{ tag: string; count: number } | null> {
  const describe = await gitString(["describe", "--tags", "--long", "--abbrev=7"], root, editor)
  if (!describe) return null
  const match = /^(.*)-(\d+)-g[0-9a-f]+$/.exec(describe)
  if (!match) return { tag: describe, count: 0 }
  return { tag: match[1]!, count: Number(match[2]!) }
}

async function absoluteGitDir(root: string, editor?: Editor): Promise<string> {
  return (await gitString(["rev-parse", "--absolute-git-dir"], root, editor)) ?? join(root, ".git")
}

function gitStatePath(gitDir: string, rel: string): string {
  return isAbsolute(rel) ? rel : join(gitDir, rel)
}

function gitStateExists(gitDir: string, rel: string): boolean {
  return existsSync(gitStatePath(gitDir, rel))
}

async function readGitStateFile(gitDir: string, rel: string): Promise<string | null> {
  try {
    return await readFile(gitStatePath(gitDir, rel), "utf8")
  } catch {
    return null
  }
}

async function readGitStateLine(gitDir: string, rel: string): Promise<string | null> {
  const text = await readGitStateFile(gitDir, rel)
  return text == null ? null : trimOrNull(text.split(/\r?\n/, 1)[0] ?? "")
}

function fileDisplayName(change: FileChange | MagitEntry): string {
  return change.oldFile && change.oldFile !== change.file
    ? `${change.oldFile} -> ${change.file}`
    : change.file
}

function entryPathspecs(entry: MagitEntry): string[] {
  return entry.oldFile && entry.oldFile !== entry.file ? [entry.oldFile, entry.file] : [entry.file]
}

function commitShaFromLine(line: string): string {
  return /\b([0-9a-f]{7,40})\b/.exec(line)?.[1] ?? line
}

function insertCommitLine(builder: MagitSectionBuilder, line: string): void {
  builder.insertSection({ type: "commit", value: commitShaFromLine(line) }, () => {
    builder.insertHeading(line)
  })
}

function insertCommitListSection(
  builder: MagitSectionBuilder,
  options: { type: string; value: string; title: string; commits: string[]; hidden?: boolean },
): void {
  if (!options.commits.length) return
  builder.insertSection({ type: options.type, value: options.value, hidden: options.hidden ?? false }, () => {
    builder.insertHeading(`${options.title} (${options.commits.length})`)
    for (const commit of options.commits) insertCommitLine(builder, commit)
    builder.insert("\n")
  })
}

async function revCommitLine(root: string, rev: string | null, action: string, editor?: Editor): Promise<string | null> {
  if (!rev) return null
  const line = await revisionLine(root, rev, editor)
  if (line) return `${action} ${line}`
  return `${action} ${await shortRevision(root, rev, editor)}`
}

function parseSequenceTodo(text: string | null): string[] {
  if (!text) return []
  return text.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"))
}

async function patchSubject(path: string): Promise<string> {
  try {
    const text = await readFile(path, "utf8")
    const subject = text.split(/\r?\n/).find(line => /^Subject:\s*/i.test(line))
    if (subject) return subject.replace(/^Subject:\s*/i, "").trim()
  } catch {
    // Fall through to filename.
  }
  return basename(path)
}

async function insertInProgressSections(
  builder: MagitSectionBuilder,
  root: string,
  gitDir: string,
  conflicted: FileChange[],
  insertConflicts: () => void,
  editor?: Editor,
): Promise<boolean> {
  let conflictsInserted = false
  const maybeInsertConflicts = () => {
    if (!conflictsInserted && conflicted.length) {
      insertConflicts()
      conflictsInserted = true
    }
  }

  const mergeHeads = (await readGitStateFile(gitDir, "MERGE_HEAD"))
    ?.split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean) ?? []
  if (mergeHeads.length) {
    const names = await Promise.all(mergeHeads.map(head => displayRevName(root, head, editor)))
    const lines = await Promise.all(mergeHeads.map(head => revCommitLine(root, head, "merge", editor)))
    builder.insertSection({ type: "merge", value: mergeHeads }, () => {
      builder.insertHeading(`Merging ${names.join(", ")}`)
      for (let i = 0; i < mergeHeads.length; i++) {
        insertCommitLine(builder, lines[i] ?? `merge ${mergeHeads[i]!.slice(0, 7)} ${names[i] ?? ""}`)
      }
      maybeInsertConflicts()
      builder.insert("\n")
    })
  }

  const amInProgress = gitStateExists(gitDir, "rebase-apply/applying")
  const rebaseMerge = gitStateExists(gitDir, "rebase-merge")
  const rebaseApply = gitStateExists(gitDir, "rebase-apply/onto") && !amInProgress
  if (rebaseMerge || rebaseApply) {
    const dir = rebaseMerge ? "rebase-merge" : "rebase-apply"
    const headName = await readGitStateLine(gitDir, `${dir}/head-name`)
    const onto = await readGitStateLine(gitDir, `${dir}/onto`)
    const done = parseSequenceTodo(await readGitStateFile(gitDir, `${dir}/done`))
    const todo = parseSequenceTodo(await readGitStateFile(gitDir, `${dir}/git-rebase-todo`))
    const displayHead = shortenRefName(headName ?? "HEAD")
    const displayOnto = await displayRevName(root, onto, editor)
    builder.insertSection({ type: "rebase-sequence", value: onto ?? "rebase" }, () => {
      builder.insertHeading(`Rebasing ${displayHead} onto ${displayOnto}`)
      if (done.length) {
        builder.insertSection({ type: "rebase-done", value: done.length, hidden: true }, () => {
          builder.insertHeading(`Done (${done.length})`)
          for (const line of done) insertCommitLine(builder, line)
        })
      }
      if (todo.length) {
        builder.insertSection({ type: "rebase-todo", value: todo.length }, () => {
          builder.insertHeading(`Todo (${todo.length})`)
          for (const line of todo) insertCommitLine(builder, line)
        })
      }
      maybeInsertConflicts()
      builder.insert("\n")
    })
  }

  if (amInProgress) {
    const dir = gitStatePath(gitDir, "rebase-apply")
    const next = Number(await readGitStateLine(gitDir, "rebase-apply/next"))
    const last = Number(await readGitStateLine(gitDir, "rebase-apply/last"))
    const names = await readdir(dir).catch(() => [] as string[])
    const patches = names
      .filter(name => /^\d+$/.test(name))
      .sort()
      .filter(name => {
        const n = Number(name)
        return Number.isFinite(next) && Number.isFinite(last) ? n >= next && n <= last : true
      })
    const patchLines = await Promise.all(patches.map(async (name, index) => {
      const action = index === 0 ? "stop" : "pick"
      return `${action} ${name} ${await patchSubject(join(dir, name))}`
    }))
    builder.insertSection({ type: "am-sequence", value: "rebase-apply" }, () => {
      builder.insertHeading("Applying patches")
      for (const line of patchLines) insertCommitLine(builder, line)
      maybeInsertConflicts()
      builder.insert("\n")
    })
  }

  const cherryHead = await readGitStateLine(gitDir, "CHERRY_PICK_HEAD")
  const revertHead = await readGitStateLine(gitDir, "REVERT_HEAD")
  const sequencerTodo = parseSequenceTodo(await readGitStateFile(gitDir, "sequencer/todo"))
  const firstTodo = sequencerTodo[0] ?? ""
  const picking = !!cherryHead || firstTodo.startsWith("pick ")
  const reverting = !!revertHead || firstTodo.startsWith("revert ")
  if (picking || reverting) {
    const current = picking ? cherryHead : revertHead
    const currentLine = await revCommitLine(root, current, picking ? "pick" : "revert", editor)
    const remaining = current ? sequencerTodo.slice(1) : sequencerTodo
    builder.insertSection({ type: "sequence", value: picking ? "cherry-pick" : "revert" }, () => {
      builder.insertHeading(picking ? "Cherry Picking" : "Reverting")
      if (currentLine) insertCommitLine(builder, currentLine)
      if (remaining.length) {
        builder.insertSection({ type: "sequence-todo", value: remaining.length }, () => {
          builder.insertHeading(`Todo (${remaining.length})`)
          for (const line of remaining) insertCommitLine(builder, line)
        })
      }
      maybeInsertConflicts()
      builder.insert("\n")
    })
  }

  if (gitStateExists(gitDir, "BISECT_LOG")) {
    const start = await readGitStateLine(gitDir, "BISECT_START")
    const terms = (await readGitStateFile(gitDir, "BISECT_TERMS"))
      ?.split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean) ?? []
    const logLines = (await readGitStateFile(gitDir, "BISECT_LOG"))
      ?.split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.startsWith("git bisect "))
      .slice(-8) ?? []
    builder.insertSection({ type: "bisect", value: "BISECT_LOG", hidden: true }, () => {
      builder.insertHeading("Bisecting")
      if (start) builder.insert(`Start: ${start}\n`)
      if (terms.length) builder.insert(`Terms: ${terms.join(", ")}\n`)
      for (const line of logLines) builder.insert(`${line}\n`)
      builder.insert("\n")
    })
  }

  return conflictsInserted
}

export type MagitStatus = {
  root: string
  text: string
  entries: MagitEntry[]
  hunks: MagitHunk[]
  rootSection: MagitSection
}

const DEFAULT_DIFF_CONTEXT = 3

export async function buildStatus(
  root: string,
  cacheOrFolded: Map<string, MagitSectionVisibility> | ReadonlySet<string> = new Map(),
  context = DEFAULT_DIFF_CONTEXT,
  editor?: Editor,
): Promise<MagitStatus> {
  const diffContextArgs = magitDiffContextArgs(context)
  const [status, headMsg, unstagedDiff, stagedDiff, log, stashList, gitDir, modules, worktrees] = await Promise.all([
    git(["status", "--porcelain=v2", "--branch", "--renames"], root, undefined, undefined, editor),
    git(["log", "-1", "--pretty=%s"], root, undefined, undefined, editor),
    git(["diff", "--find-renames", ...diffContextArgs], root, undefined, undefined, editor),
    git(["diff", "--cached", "--find-renames", ...diffContextArgs], root, undefined, undefined, editor),
    git(["log", "-n", "10", "--pretty=%h %s"], root, undefined, undefined, editor),
    git(["stash", "list"], root, undefined, undefined, editor),
    absoluteGitDir(root, editor),
    listSubmodules(root, editor),
    listWorktrees(root, editor),
  ])
  const { branch, upstream, files } = parsePorcelain(status.out)
  const unstagedDiffs = new Map(parseDiff(unstagedDiff.out).map(d => [d.file, d]))
  const stagedDiffs = new Map(parseDiff(stagedDiff.out).map(d => [d.file, d]))

  const conflicted = files.filter(f => f.unmerged || f.xy.includes("U") || f.xy === "AA" || f.xy === "DD")
  const untracked = files.filter(f => f.xy === "??")
  const unstaged = files.filter(f => !conflicted.includes(f) && f.xy !== "??" && f.xy[1] !== "." && f.xy[1] !== undefined)
  const staged = files.filter(f => !conflicted.includes(f) && f.xy[0] !== "." && f.xy[0] !== "?")

  const entries: MagitEntry[] = []
  const hunks: MagitHunk[] = []
  const visibility = cacheOrFolded instanceof Map ? cacheOrFolded : new Map<string, MagitSectionVisibility>()
  const builder = new MagitSectionBuilder({ visibilityCache: visibility })

  const insertFileSection = (f: FileChange, isStaged: boolean, diffs: Map<string, FileDiff>, codeOverride?: string) => {
    const code = codeOverride ?? (f.unmerged ? "U" : isStaged ? f.xy[0]! : f.xy[1]!)
    const entry: MagitEntry = {
      file: f.file,
      oldFile: f.oldFile,
      staged: isStaged,
      untracked: code === "?",
      conflicted: code === "U",
      startLine: 0,
      endLine: 0,
    }
    entries.push(entry)
    builder.insertSection({ type: "file", value: entry }, section => {
      entry.startLine = lineNumberAtTextPoint(builder.toString(), section.start)
      builder.insertHeading(`${changeLabel(code)} ${fileDisplayName(f)}`)
      const fd = diffs.get(f.file)
      for (const h of fd?.hunks ?? []) {
        const patch = hunkPatch(fd!, h)
        const hunk: MagitHunk = { file: f.file, oldFile: f.oldFile, staged: isStaged, startLine: 0, endLine: 0, patch }
        hunks.push(hunk)
        builder.insertSection({ type: "hunk", value: hunk }, hunkSection => {
          hunk.startLine = lineNumberAtTextPoint(builder.toString(), hunkSection.start)
          builder.insertHeading(h.header)
          for (const line of h.lines) builder.insert(`${line}\n`)
        })
        hunk.endLine = lineNumberAtTextPoint(builder.toString(), builder.length)
      }
    })
    entry.endLine = lineNumberAtTextPoint(builder.toString(), builder.length)
  }

  const insertConflictedFilesSection = () => {
    if (!conflicted.length) return
    builder.insertSection({ type: "conflicts", value: conflicted.length }, () => {
      builder.insertHeading(`Conflicts (${conflicted.length})`)
      for (const f of conflicted) insertFileSection(f, false, unstagedDiffs, "U")
      builder.insert("\n")
    })
  }

  const insertChangeSection = (type: string, title: string, items: FileChange[], isStaged: boolean, diffs: Map<string, FileDiff>) => {
    if (!items.length) return
    builder.insertSection({ type, value: items.length }, () => {
      builder.insertHeading(`${title} (${items.length})`)
      for (const f of items) insertFileSection(f, isStaged, diffs)
      builder.insert("\n")
    })
  }

  const headName = branch && branch !== "(detached)" ? branch : await shortRevision(root, "HEAD", editor)
  const headSummary = trimOrNull(headMsg.out) ?? "(no commit message)"
  const [upstreamKind, pushTarget, tag] = await Promise.all([
    upstream ? upstreamHeaderLabel(root, branch, editor) : Promise.resolve(null),
    pushBranchTarget(root, branch, editor),
    describedTag(root, editor),
  ])
  const [upstreamSummary, pushSummary] = await Promise.all([
    upstream ? revisionSummary(root, upstream, editor) : Promise.resolve(null),
    pushTarget ? revisionSummary(root, pushTarget, editor) : Promise.resolve(null),
  ])

  builder.insertSection({ type: "status", value: root }, () => {
    builder.insertHeading(statusHeader("Head:", `${headName} ${headSummary}`).trimEnd())
    if (upstream && upstreamKind) {
      builder.insert(statusHeader(upstreamKind, `${upstream} ${upstreamSummary ?? "does not exist"}`))
    }
    if (pushTarget) {
      builder.insert(statusHeader("Push:", `${pushTarget} ${pushSummary ?? "does not exist"}`))
    }
    if (tag) {
      builder.insert(statusHeader("Tag:", `${tag.tag} (${tag.count})`))
    }
    if (gitStateExists(gitDir, "BISECT_LOG")) {
      builder.insert(statusHeader("Bisect:", "in progress"))
    }
    builder.insert("\n")
  })

  const conflictsInserted = await insertInProgressSections(builder, root, gitDir, conflicted, insertConflictedFilesSection, editor)
  if (conflicted.length && !conflictsInserted) insertConflictedFilesSection()

  const insertAheadBehindSections = async (target: string, valuePrefix: string) => {
    const aheadBehind = await git(["rev-list", "--count", "--left-right", `HEAD...${target}`], root, undefined, undefined, editor)
    if (aheadBehind.code !== 0) return
    const [aheadRaw, behindRaw] = aheadBehind.out.trim().split(/\s+/)
    const ahead = Number(aheadRaw)
    const behind = Number(behindRaw)
    if (Number.isFinite(ahead) && ahead > 0) {
      const commits = (await git(["log", "--oneline", `${target}..HEAD`], root, undefined, undefined, editor)).out.split("\n").filter(Boolean)
      insertCommitListSection(builder, {
        type: "unpushed",
        value: `${valuePrefix}${target}..`,
        title: `Unpushed to ${target}`,
        commits,
        hidden: true,
      })
    }
    if (Number.isFinite(behind) && behind > 0) {
      const commits = (await git(["log", "--oneline", `HEAD..${target}`], root, undefined, undefined, editor)).out.split("\n").filter(Boolean)
      insertCommitListSection(builder, {
        type: "unpulled",
        value: `${valuePrefix}..${target}`,
        title: `Unpulled from ${target}`,
        commits,
        hidden: true,
      })
    }
  }

  if (upstream) await insertAheadBehindSections(upstream, "upstream:")
  if (pushTarget && pushTarget !== upstream) await insertAheadBehindSections(pushTarget, "push:")

  insertChangeSection("untracked", "Untracked files", untracked, false, unstagedDiffs)
  insertChangeSection("unstaged", "Unstaged changes", unstaged, false, unstagedDiffs)
  insertChangeSection("staged", "Staged changes", staged, true, stagedDiffs)

  const stashes = stashList.out.split("\n").filter(Boolean)
  if (stashes.length) {
    builder.insertSection({ type: "stashes", value: stashes.length }, () => {
      builder.insertHeading(`Stashes (${stashes.length})`)
      for (const s of stashes) {
        const ref = /^stash@\{\d+\}/.exec(s)?.[0] ?? s.split(":", 1)[0] ?? s
        builder.insertSection({ type: "stash", value: ref }, () => {
          builder.insertHeading(s)
        })
      }
      builder.insert("\n")
    })
  }

  if (modules.length) {
    builder.insertSection({ type: "modules", value: modules.length }, () => {
      builder.insertHeading(`Modules (${modules.length})`)
      for (const module of modules) {
        builder.insertSection({ type: "module", value: module }, () => {
          builder.insertHeading(`  ${module.path}${module.url ? ` ${module.url}` : ""}`)
        })
      }
      builder.insert("\n")
    })
  }

  if (worktrees.length > 1) {
    builder.insertSection({ type: "worktrees", value: worktrees.length }, () => {
      builder.insertHeading(`Worktrees (${worktrees.length})`)
      for (const worktree of worktrees) {
        builder.insertSection({ type: "worktree", value: worktree }, () => {
          builder.insertHeading(worktreeLabel(worktree))
        })
      }
      builder.insert("\n")
    })
  }

  const commits = log.out.split("\n").filter(Boolean)
  if (commits.length) {
    builder.insertSection({ type: "recent", value: commits.length }, () => {
      builder.insertHeading("Recent commits")
      for (const c of commits) insertCommitLine(builder, c)
      builder.insert("\n")
    })
  }

  const text = builder.toString()
  builder.root.end = text.length
  return { root, text, entries, hunks, rootSection: builder.root }
}

function lineAt(buffer: BufferModel): number {
  return buffer.text.slice(0, buffer.point).split("\n").length - 1
}

export function entryAtPoint(buffer: BufferModel): MagitEntry | null {
  const section = sectionOfType(buffer, "file")
  if (section) return section.value as MagitEntry
  const entries = buffer.locals.get("magit-entries") as MagitEntry[] | undefined
  if (!entries) return null
  const line = lineAt(buffer)
  return entries.find(e => line >= e.startLine && line <= e.endLine) ?? null
}

export function hunkAtPoint(buffer: BufferModel): MagitHunk | null {
  const section = sectionOfType(buffer, "hunk")
  if (section) return section.value as MagitHunk
  const hunks = buffer.locals.get("magit-hunks") as MagitHunk[] | undefined
  if (!hunks) return null
  const line = lineAt(buffer)
  return hunks.find(h => line >= h.startLine && line <= h.endLine) ?? null
}

function stashAtPoint(buffer: BufferModel): string | null {
  const section = sectionOfType(buffer, "stash")
  if (section && typeof section.value === "string") return section.value
  const line = buffer.text.split("\n")[lineAt(buffer)] ?? ""
  return /\bstash@\{\d+\}/.exec(line)?.[0] ?? null
}

function refAtPoint(buffer: BufferModel): MagitRef | null {
  const section = sectionOfType(buffer, "ref")
  const value = section?.value as MagitRef | undefined
  return value?.name && value?.kind ? value : null
}

function moduleAtPoint(buffer: BufferModel): MagitModule | null {
  const section = sectionOfType(buffer, "module")
  const value = section?.value as MagitModule | undefined
  return value?.path ? value : null
}

function worktreeAtPoint(buffer: BufferModel): MagitWorktree | null {
  const section = sectionOfType(buffer, "worktree")
  const value = section?.value as MagitWorktree | undefined
  return value?.path ? value : null
}

function sectionOfType(buffer: BufferModel, type: string): MagitSection | null {
  for (let section = currentSection(buffer); section; section = section.parent) {
    if (section.type === type) return section
  }
  return null
}

async function refresh(editor: Editor, root: string, point?: number): Promise<BufferModel> {
  const name = `*magit: ${basename(root)}*`
  const prev = [...editor.buffers.values()].find(b => b.name === name)
  const cache = (prev?.locals.get(MAGIT_SECTION_VISIBILITY_CACHE_LOCAL) as Map<string, MagitSectionVisibility> | undefined) ?? new Map<string, MagitSectionVisibility>()
  const context = magitDiffContext(prev)
  const status = await buildStatus(root, cache, context, editor)
  // Preserving the byte offset is only sound when the section layout is stable
  // (g/s/u). Callers that reshape the buffer — commit drops the whole Staged
  // section — pass an explicit point so we don't land mid-word (t-6bbb608e).
  const keepPoint = point ?? prev?.point ?? 0
  const buf = editor.scratch(name, status.text, "magit-status")
  buf.readOnly = true
  buf.path = root
  buf.locals.set("magit-root", root)
  buf.locals.set("magit-entries", status.entries)
  buf.locals.set("magit-hunks", status.hunks)
  buf.locals.set(MAGIT_SECTION_VISIBILITY_CACHE_LOCAL, cache)
  buf.locals.set("magit-diff-context", context)
  setRootSection(buf, status.rootSection)
  buf.point = Math.min(keepPoint, buf.text.length)
  return buf
}

function magitRoot(buffer: BufferModel): string | null {
  return (buffer.locals.get("magit-root") as string | undefined) ?? null
}

function magitHistory(buffer: BufferModel, direction: "backward" | "forward"): MagitHistoryMark[] {
  const key = direction === "backward" ? "magit-history-backward" : "magit-history-forward"
  let stack = buffer.locals.get(key) as MagitHistoryMark[] | undefined
  if (!stack) {
    stack = []
    buffer.locals.set(key, stack)
  }
  return stack
}

function magitHistoryMark(buffer: BufferModel): MagitHistoryMark {
  return { bufferId: buffer.id, point: buffer.point }
}

function pushMagitHistory(target: BufferModel, source: BufferModel): void {
  magitHistory(target, "backward").push(magitHistoryMark(source))
  target.locals.set("magit-history-forward", [])
}

function magitGo(editor: Editor, buffer: BufferModel, direction: "backward" | "forward"): boolean {
  const stack = magitHistory(buffer, direction)
  const mark = stack.pop()
  if (!mark) return false
  const target = editor.buffers.get(mark.bufferId)
  if (!target) return false
  magitHistory(target, direction === "backward" ? "forward" : "backward").push(magitHistoryMark(buffer))
  editor.switchToBuffer(target.id)
  target.point = Math.max(0, Math.min(mark.point, target.text.length))
  editor.setSelectedWindowPoint(target.point)
  void editor.changed(direction === "backward" ? "magit-go-backward" : "magit-go-forward")
  return true
}

function magitDiffContext(buffer: BufferModel | undefined): number {
  const value = buffer?.locals.get("magit-diff-context")
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : DEFAULT_DIFF_CONTEXT
}

function magitDiffContextArgs(context: number): string[] {
  return context === DEFAULT_DIFF_CONTEXT ? [] : [`-U${context}`]
}

function withDiffOptions(baseArgs: string[], extraArgs: string[]): string[] {
  if (!extraArgs.length) return [...baseArgs]
  const dashDash = baseArgs.indexOf("--")
  if (dashDash < 0) return [...baseArgs, ...extraArgs]
  return [...baseArgs.slice(0, dashDash), ...extraArgs, ...baseArgs.slice(dashDash)]
}

function displayDiffContextArgs(baseArgs: string[], context: number): string[] {
  return baseArgs.includes("--stat") ? [] : magitDiffContextArgs(context)
}

function magitDiffBaseArgs(buffer: BufferModel): string[] | null {
  const args = buffer.locals.get("magit-diff-args") as string[] | undefined
  return args ? [...args] : null
}

type ParsedDiffArgs = {
  flags: string[]
  context: number | null
  range: string | null
  paths: string[]
  positionals: string[]
}

function numericContext(value: string | undefined): number | null {
  if (value == null || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : null
}

function parseMagitDiffArgs(args: readonly string[]): ParsedDiffArgs {
  const flags: string[] = []
  const paths: string[] = []
  const positionals: string[] = []
  let context: number | null = null
  let range: string | null = null
  let afterDashDash = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (afterDashDash) {
      paths.push(arg)
      continue
    }
    if (arg === "--") {
      afterDashDash = true
      continue
    }
    if (arg === "--ignore-all-space" || arg === "-w") {
      flags.push("--ignore-all-space")
      continue
    }
    if (arg === "--ignore-space-change" || arg === "-b") {
      flags.push("--ignore-space-change")
      continue
    }
    if (arg === "--stat") {
      flags.push("--stat")
      continue
    }
    if (arg === "--find-renames" || arg === "-M") {
      flags.push("--find-renames")
      continue
    }
    if (arg.startsWith("-U") && arg.length > 2) {
      context = numericContext(arg.slice(2))
      continue
    }
    if (arg === "-U" || arg === "--unified") {
      context = numericContext(args[++i])
      continue
    }
    if (arg.startsWith("--unified=")) {
      context = numericContext(arg.slice("--unified=".length))
      continue
    }
    if (arg === "--range") {
      range = args[++i] ?? null
      continue
    }
    if (arg.startsWith("--range=")) {
      range = arg.slice("--range=".length)
      continue
    }
    positionals.push(arg)
  }
  return { flags: [...new Set(flags)], context, range, paths, positionals }
}

function diffCommandArgs(
  kind: "working-tree" | "unstaged" | "staged" | "range",
  commandArgs: readonly string[],
  buffer: BufferModel,
  fallbackContext: number,
  explicitRange?: string | null,
): { gitArgs: string[]; context: number; title: string } | null {
  const parsed = parseMagitDiffArgs(commandArgs)
  const paths = parsed.paths
  const context = parsed.context ?? fallbackContext
  const revRange = explicitRange ?? parsed.range ?? parsed.positionals[0] ?? null
  const args = ["diff", ...parsed.flags]
  let title = "diff"
  if (kind === "working-tree") {
    args.push("HEAD")
    title = "working tree"
  } else if (kind === "staged") {
    args.push("--cached")
    title = "staged"
  } else if (kind === "unstaged") {
    title = "unstaged"
  } else {
    if (!revRange) return null
    args.push(refname(revRange))
    title = revRange
  }
  if (paths.length) args.push("--", ...paths)
  return { gitArgs: args, context, title: paths.length ? `${title}: ${paths.join(" ")}` : title }
}

type ParsedLogArgs = {
  flags: string[]
  maxCount: string | null
  follow: boolean
  revs: string[]
  paths: string[]
}

function parseMagitLogArgs(args: readonly string[]): ParsedLogArgs {
  const flags: string[] = []
  const revs: string[] = []
  const paths: string[] = []
  let maxCount: string | null = null
  let follow = false
  let afterDashDash = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (afterDashDash) {
      paths.push(arg)
      continue
    }
    if (arg === "--") {
      afterDashDash = true
      continue
    }
    if (arg === "--graph" || arg === "--decorate" || arg === "-p") {
      flags.push(arg)
      continue
    }
    if (arg === "--follow") {
      follow = true
      continue
    }
    if (arg === "--author" || arg === "--grep" || arg === "--max-count") {
      const value = args[++i] ?? ""
      if (arg === "--max-count") maxCount = value
      else if (value) flags.push(`${arg}=${value}`)
      continue
    }
    if (arg.startsWith("--author=") || arg.startsWith("--grep=")) {
      flags.push(arg)
      continue
    }
    if (arg.startsWith("--max-count=")) {
      maxCount = arg.slice("--max-count=".length)
      continue
    }
    if (/^-n\d+$/.test(arg)) {
      maxCount = arg.slice(2)
      continue
    }
    if (arg === "-n") {
      maxCount = args[++i] ?? null
      continue
    }
    revs.push(arg)
  }
  return { flags: [...new Set(flags)], maxCount, follow, revs, paths }
}

function magitLogStoredArgs(buffer: BufferModel): string[] {
  return [...((buffer.locals.get("magit-log-args") as string[] | undefined) ?? [])]
}

function logCommandArgs(
  commandArgs: readonly string[],
  options: { all?: boolean; branch?: string | null; pathspec?: string | null } = {},
): { gitArgs: string[]; storedArgs: string[] } {
  const parsed = parseMagitLogArgs(commandArgs)
  const maxCount = numericContext(parsed.maxCount ?? undefined) ?? 50
  const flags = new Set(parsed.flags)
  flags.add("--graph")
  const revs = options.all ? ["--all"] : options.branch ? [refname(options.branch)] : parsed.revs.map(refname)
  const pathspec = options.pathspec ?? parsed.paths[0] ?? null
  const args = ["log", "--oneline", `-n${maxCount}`, ...flags]
  if (pathspec && parsed.follow) args.push("--follow")
  args.push(...revs)
  if (pathspec) args.push("--", pathspec)
  return { gitArgs: args, storedArgs: [...commandArgs] }
}

function modeDerivesFrom(mode: string, parent: string): boolean {
  return modeLineage(mode).some(entry => entry.name === parent)
}

async function refreshDiffBuffer(editor: Editor, buffer: BufferModel, context: number): Promise<boolean> {
  const root = magitRoot(buffer)
  if (!root) return false
  if (buffer.mode === "magit-status") {
    const point = buffer.point
    const status = await buildStatus(root, visibilityCache(buffer), context, editor)
    buffer.setText(status.text, false)
    buffer.locals.set("magit-entries", status.entries)
    buffer.locals.set("magit-hunks", status.hunks)
    buffer.locals.set("magit-diff-context", context)
    setRootSection(buffer, status.rootSection)
    buffer.point = Math.min(point, buffer.text.length)
    editor.message(`Diff context is ${context}`)
    return true
  }
  const baseArgs = magitDiffBaseArgs(buffer)
  const title = buffer.locals.get("magit-diff-title") as string | undefined
  if (!baseArgs || !title) return false
  const { out } = await git(withDiffOptions(baseArgs, displayDiffContextArgs(baseArgs, context)), root, undefined, undefined, editor)
  buffer.readOnly = false
  buffer.setText(out || "(no changes)\n", false)
  buffer.readOnly = true
  buffer.locals.set("magit-diff-context", context)
  buffer.point = 0
  editor.message(`Diff context is ${context}`)
  return true
}

async function showCommitDiff(editor: Editor, commitBuffer: BufferModel): Promise<boolean> {
  const root = magitRoot(commitBuffer)
  if (!root || commitBuffer.mode !== "magit-commit") return false
  const context = magitDiffContext(commitBuffer)
  const { out: diff } = await git(["diff", "--cached", ...magitDiffContextArgs(context)], root, undefined, undefined, editor)
  const diffBuf = editor.scratch("*magit-diff: staged*", diff || "(nothing staged)\n", "magit-diff-mode")
  diffBuf.readOnly = true
  diffBuf.locals.set("magit-root", root)
  diffBuf.locals.set("magit-diff-args", ["diff", "--cached"])
  diffBuf.locals.set("magit-diff-title", "staged")
  diffBuf.locals.set("magit-diff-context", context)
  diffBuf.point = 0
  editor.switchToBuffer(commitBuffer.id)
  editor.displayBufferInOtherWindow(diffBuf.id, { select: false })
  editor.message("Showing staged diff for commit")
  return true
}

function commitMessageBuffer(editor: Editor): BufferModel | null {
  return [...editor.buffers.values()].find(buffer => buffer.mode === "magit-commit") ?? null
}

async function showRevision(editor: Editor, root: string, sha: string, source?: BufferModel): Promise<BufferModel> {
  const { out } = await git(["show", "--stat", "-p", sha], root, undefined, undefined, editor)
  const buf = editor.scratch(`*magit-commit: ${sha}*`, out, "magit-revision-mode")
  buf.readOnly = true
  buf.locals.set("magit-root", root)
  buf.locals.set("magit-diff-args", ["diff", `${sha}^!`])
  if (source) pushMagitHistory(buf, source)
  buf.point = 0
  return buf
}

function prefixCount(prefix: unknown): number {
  if (typeof prefix === "number" && Number.isFinite(prefix)) return Math.max(1, Math.trunc(Math.abs(prefix)))
  return 1
}

/** Diff-mode highlighting plus Magit section headers for status/revision buffers. */
export function magitDiffFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const sectionSpans: TextSpan[] = []
  const { text, offset: base } = fontLockSlice(buffer, range)
  let offset = base
  for (const line of text.split("\n")) {
    const end = offset + line.length
    if (/^(Head|Merge|Rebase|Push|Tag|Tags|Branches|Bisect|Merging|Rebasing|Applying|Cherry Picking|Reverting|Conflicts|Done|Todo|Untracked|Unstaged|Staged|Stashes|Modules|Worktrees|Recent|Unpushed|Unpulled)\b/.test(line)) {
      sectionSpans.push({ start: offset, end, face: "keyword" })
    }
    offset = end + 1
  }
  const refineSetting = getCustom<false | null | "t" | "all" | boolean>("magit-diff-refine-hunk")
  const refine = refineSetting === "all"
    ? magitDiffRefineSpans(buffer.text, { all: true })
    : refineSetting === true || refineSetting === "t"
      ? magitDiffRefineSpans(buffer.text, { point: buffer.point })
      : []
  const boundedRefine = range
    ? refine.filter(span => span.end >= range.start && span.start <= range.end)
    : refine
  return [...sectionSpans, ...diffFontLockText(text, base), ...boundedRefine]
}

function fontLockSlice(buffer: BufferModel, range?: FontLockRange): { text: string; offset: number } {
  if (!range) return { text: buffer.text, offset: 0 }
  const startLine = Math.max(0, Math.min(range.startLine, buffer.lineCount - 1))
  const endLine = Math.max(startLine, Math.min(range.endLine, buffer.lineCount))
  const start = buffer.lineStarts[startLine] ?? 0
  const end = endLine < buffer.lineCount ? buffer.lineStarts[endLine]! : buffer.text.length
  return { text: buffer.text.slice(start, end), offset: start }
}

/** Extract the 7+ hex sha at point from a `--graph --oneline` line. */
export function logShaAtPoint(buffer: BufferModel): string | null {
  const line = lineAt(buffer)
  const text = buffer.text.split("\n")[line] ?? ""
  return /\b([0-9a-f]{7,40})\b/.exec(text)?.[1] ?? null
}

function commitishAtPoint(buffer: BufferModel): string | null {
  for (let section = currentSection(buffer); section; section = section.parent) {
    if (section.type === "commit" && typeof section.value === "string") return commitShaFromLine(section.value)
    if (section.type === "stash" && typeof section.value === "string") return section.value
  }
  const blamed = blameShaAtPoint(buffer)
  if (blamed) return blamed
  const line = buffer.text.split("\n")[lineAt(buffer)] ?? ""
  const stash = /\bstash@\{\d+\}/.exec(line)?.[0]
  if (stash) return stash
  return logShaAtPoint(buffer)
}

function lineStartsFor(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10 && i + 1 < text.length) starts.push(i + 1)
  return starts
}

function lineNumberAtTextPoint(text: string, point: number): number {
  const clamped = Math.max(0, Math.min(point, text.length))
  let line = 0
  for (let i = 0; i < clamped; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

export function magitDiffVisitTarget(text: string, point: number, fileHint?: string): { file: string; line: number } | null {
  const starts = lineStartsFor(text)
  const currentLine = lineNumberAtTextPoint(text, point)
  let file = fileHint ?? ""
  let oldLine = 0
  let newLine = 0
  let inHunk = false

  for (let i = 0; i <= currentLine && i < starts.length; i++) {
    const start = starts[i]!
    const end = text.indexOf("\n", start)
    const line = text.slice(start, end < 0 ? text.length : end)
    const diff = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
    if (diff?.[2]) {
      file = diff[2]
      inHunk = false
      continue
    }
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      inHunk = true
      if (i === currentLine) return null
      continue
    }
    if (!inHunk) continue
    if (i === currentLine) {
      if (!file || !/^[ +\-]/.test(line)) return null
      if (line.startsWith("-")) return { file, line: oldLine }
      return { file, line: newLine }
    }
    if (line.startsWith(" ")) {
      oldLine++
      newLine++
    } else if (line.startsWith("-")) {
      oldLine++
    } else if (line.startsWith("+")) {
      newLine++
    } else if (!line.startsWith("\\")) {
      inHunk = false
    }
  }
  return null
}

async function repositoryRootForFile(path: string): Promise<string | null> {
  const dir = path.slice(0, path.lastIndexOf("/")) || "/"
  const rootResult = await git(["rev-parse", "--show-toplevel"], dir)
  const root = rootResult.out.trim()
  return rootResult.code === 0 && root ? root : null
}

/** git prints realpaths (macOS /var → /private/var), so resolve the buffer's
 *  path the same way before computing a repo-relative pathspec. */
async function repoRelativePath(root: string, path: string): Promise<string> {
  const real = await realpath(path).catch(() => path)
  return relative(root, real)
}

async function openLog(
  editor: Editor,
  root: string,
  source?: BufferModel,
  options: { args?: string[]; pathspec?: string | null; all?: boolean; branch?: string | null } = {},
): Promise<BufferModel> {
  const commandArgs = options.args ?? magitLogStoredArgs(source ?? editor.currentBuffer)
  const { gitArgs, storedArgs } = logCommandArgs(commandArgs, options)
  const { out } = await git(gitArgs, root, undefined, undefined, editor)
  const title = "*magit-log*"
  const buf = editor.scratch(title, out || "(no commits)\n", "magit-log")
  buf.readOnly = true
  buf.path = root
  buf.locals.set("magit-root", root)
  buf.locals.set("magit-log-args", storedArgs)
  if (options.pathspec) buf.locals.set("magit-log-file", options.pathspec)
  if (options.all) buf.locals.set("magit-log-all", true)
  if (options.branch) buf.locals.set("magit-log-branch", options.branch)
  if (source) pushMagitHistory(buf, source)
  buf.point = 0
  return buf
}

async function refAheadBehind(root: string, ref: string, editor?: Editor): Promise<{ ahead: number; behind: number } | null> {
  const { out, code } = await git(["rev-list", "--left-right", "--count", `HEAD...${ref}`], root, undefined, undefined, editor)
  if (code !== 0) return null
  const [leftRaw, rightRaw] = out.trim().split(/\s+/)
  const behind = Number(leftRaw)
  const ahead = Number(rightRaw)
  return Number.isFinite(ahead) && Number.isFinite(behind) ? { ahead, behind } : null
}

async function refsForPrefix(root: string, prefix: string, kind: MagitRefKind, options: { remote?: string; current?: string | null } = {}, editor?: Editor): Promise<MagitRef[]> {
  const format = "%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short)%00%(subject)"
  const { out, code } = await git(["for-each-ref", `--format=${format}`, prefix], root, undefined, undefined, editor)
  if (code !== 0) return []
  return parseForEachRef(out, kind, options)
}

async function withRefCounts(root: string, refs: MagitRef[], editor?: Editor): Promise<MagitRef[]> {
  if (getCustom<boolean>("magit-refs-show-commit-count") === false) return refs
  return Promise.all(refs.map(async ref => {
    const counts = await refAheadBehind(root, ref.name, editor)
    return counts ? { ...ref, ...counts } : ref
  }))
}

function refLine(ref: MagitRef): string {
  const marker = ref.current ? "* " : "  "
  const counts = ref.ahead == null || ref.behind == null ? "" : ` +${ref.ahead} -${ref.behind}`
  const summary = ref.summary ? ` ${ref.summary}` : ""
  return `${marker}${ref.name}${counts}${summary}`
}

async function buildRefs(root: string, cache: Map<string, MagitSectionVisibility> = new Map(), editor?: Editor): Promise<{ text: string; rootSection: MagitSection; refs: MagitRef[] }> {
  const current = await gitString(["rev-parse", "--abbrev-ref", "HEAD"], root, editor)
  const remotes = (await gitString(["remote"], root, editor))?.split("\n").filter(Boolean) ?? []
  const [locals, tags, ...remoteRefs] = await Promise.all([
    refsForPrefix(root, "refs/heads", "local", { current }, editor),
    refsForPrefix(root, "refs/tags", "tag", {}, editor),
    ...remotes.map(remote => refsForPrefix(root, `refs/remotes/${remote}`, "remote", { remote }, editor)),
  ])
  const localsWithCounts = await withRefCounts(root, locals, editor)
  const tagsWithCounts = await withRefCounts(root, tags, editor)
  const remotesWithCounts = await Promise.all(remoteRefs.map(refs => withRefCounts(root, refs, editor)))
  const refs = [...localsWithCounts, ...remotesWithCounts.flat(), ...tagsWithCounts]
  const builder = new MagitSectionBuilder({ visibilityCache: cache })
  builder.insertSection({ type: "refs", value: root }, () => {
    if (localsWithCounts.length) {
      builder.insertSection({ type: "local-branches", value: localsWithCounts.length }, () => {
        builder.insertHeading(`Branches (${localsWithCounts.length})`)
        for (const ref of localsWithCounts) {
          builder.insertSection({ type: "ref", value: ref }, () => builder.insertHeading(refLine(ref)))
        }
        builder.insert("\n")
      })
    }
    for (let i = 0; i < remotes.length; i++) {
      const remote = remotes[i]!
      const refsForRemote = remotesWithCounts[i] ?? []
      if (!refsForRemote.length) continue
      builder.insertSection({ type: "remote-branches", value: remote }, () => {
        builder.insertHeading(`${remote} (${refsForRemote.length})`)
        for (const ref of refsForRemote) {
          builder.insertSection({ type: "ref", value: ref }, () => builder.insertHeading(refLine(ref)))
        }
        builder.insert("\n")
      })
    }
    if (tagsWithCounts.length) {
      builder.insertSection({ type: "tags", value: tagsWithCounts.length }, () => {
        builder.insertHeading(`Tags (${tagsWithCounts.length})`)
        for (const ref of tagsWithCounts) {
          builder.insertSection({ type: "ref", value: ref }, () => builder.insertHeading(refLine(ref)))
        }
        builder.insert("\n")
      })
    }
  })
  const text = builder.toString() || "No refs.\n"
  builder.root.end = text.length
  return { text, rootSection: builder.root, refs }
}

async function openRefs(editor: Editor, root: string, source?: BufferModel, point = 0): Promise<BufferModel> {
  const name = `*magit-refs: ${basename(root)}*`
  const prev = [...editor.buffers.values()].find(b => b.name === name)
  const cache = (prev?.locals.get(MAGIT_SECTION_VISIBILITY_CACHE_LOCAL) as Map<string, MagitSectionVisibility> | undefined) ?? new Map<string, MagitSectionVisibility>()
  const refs = await buildRefs(root, cache, editor)
  const buf = editor.scratch(name, refs.text, "magit-refs-mode")
  buf.readOnly = true
  buf.path = root
  buf.locals.set("magit-root", root)
  buf.locals.set("magit-refs", refs.refs)
  buf.locals.set(MAGIT_SECTION_VISIBILITY_CACHE_LOCAL, cache)
  setRootSection(buf, refs.rootSection)
  if (source) pushMagitHistory(buf, source)
  buf.point = Math.min(point, buf.text.length)
  return buf
}

async function visitRef(editor: Editor, root: string, ref: MagitRef, source: BufferModel): Promise<void> {
  if (ref.kind === "tag") await showRevision(editor, root, ref.name, source)
  else await openLog(editor, root, source, { branch: ref.name })
}

type MagitWithEditorProcess = {
  root: string
  done: Promise<MagitGitResult>
  session: WithEditorSession
  winconf?: ReturnType<Editor["currentWindowConfiguration"]>
  successMessage: string
  failurePrefix: string
  cancelledMessage: string
  resetPoint: boolean
  killStagedDiff: boolean
  cancelled: boolean
  finalized: boolean
}

async function startGitWithEditorFlow(
  editor: Editor,
  root: string,
  args: string[],
  options: {
    env?: Record<string, string>
    successMessage: string
    failurePrefix: string
    cancelledMessage?: string
    resetPoint?: boolean
    showCommitDiff?: boolean
    awaitOnFinish?: boolean
  },
): Promise<BufferModel | null> {
  const winconf = editor.currentWindowConfiguration()
  let openedResolve!: (buffer: BufferModel) => void
  let openedReject!: (error: Error) => void
  const opened = new Promise<BufferModel>((resolve, reject) => {
    openedResolve = resolve
    openedReject = reject
  })

  const processInfo: MagitWithEditorProcess = {
    root,
    done: Promise.resolve({ out: "", err: "", code: null }),
    session: null as unknown as WithEditorSession,
    winconf,
    successMessage: options.successMessage,
    failurePrefix: options.failurePrefix,
    cancelledMessage: options.cancelledMessage ?? "Cancelled",
    resetPoint: options.resetPoint ?? true,
    killStagedDiff: options.showCommitDiff ?? false,
    cancelled: false,
    finalized: false,
  }

  const session = await createWithEditorSession({
    onRequest: async request => {
      try {
        const editBuffer = await openWithEditorBuffer(editor, request, {
          root,
          winconf,
          awaitOnFinish: options.awaitOnFinish,
        })
        editBuffer.locals.set(WITH_EDITOR_PROCESS_LOCAL, processInfo)
        if (options.showCommitDiff && editBuffer.mode === "magit-commit") await showCommitDiff(editor, editBuffer)
        openedResolve(editBuffer)
      } catch (error) {
        openedReject(error instanceof Error ? error : new Error(String(error)))
        throw error
      }
    },
  })
  processInfo.session = session
  processInfo.done = git(args, root, undefined, { ...(options.env ?? {}), ...session.env }, editor)
    .finally(() => session.dispose())

  const openedFirst = await Promise.race([
    opened.then(() => true),
    processInfo.done.then(() => false),
  ])
  if (!openedFirst) {
    await finalizeWithEditorProcess(editor, processInfo)
    return null
  }
  return opened
}

async function finishWithEditorBuffer(editor: Editor, buffer: BufferModel): Promise<boolean> {
  const processInfo = buffer.locals.get(WITH_EDITOR_PROCESS_LOCAL) as MagitWithEditorProcess | undefined
  if (!isWithEditorBuffer(buffer)) return false
  if (buffer.mode === "magit-commit" && !gitCommitMessageBody(buffer.text)) {
    if (processInfo) {
      processInfo.cancelled = true
      processInfo.cancelledMessage = "Aborting commit due to empty message"
    }
    await abortWithEditorBuffer(buffer)
    await cleanupWithEditorBuffer(editor, buffer, processInfo)
    if (processInfo) await finalizeWithEditorProcess(editor, processInfo)
    return true
  }
  await acceptWithEditorBuffer(buffer)
  const awaitOnFinish = buffer.locals.get(WITH_EDITOR_AWAIT_ON_FINISH_LOCAL) !== false
  await cleanupWithEditorBuffer(editor, buffer, processInfo)
  if (processInfo) {
    if (awaitOnFinish) await finalizeWithEditorProcess(editor, processInfo)
    else void finalizeWithEditorProcess(editor, processInfo)
  }
  return true
}

async function abortWithEditorEdit(editor: Editor, buffer: BufferModel, message: string): Promise<boolean> {
  const processInfo = buffer.locals.get(WITH_EDITOR_PROCESS_LOCAL) as MagitWithEditorProcess | undefined
  if (!isWithEditorBuffer(buffer)) return false
  if (processInfo) {
    processInfo.cancelled = true
    processInfo.cancelledMessage = message
  }
  await abortWithEditorBuffer(buffer)
  const awaitOnFinish = buffer.locals.get(WITH_EDITOR_AWAIT_ON_FINISH_LOCAL) !== false
  await cleanupWithEditorBuffer(editor, buffer, processInfo)
  if (processInfo) {
    if (awaitOnFinish) await finalizeWithEditorProcess(editor, processInfo)
    else void finalizeWithEditorProcess(editor, processInfo)
  } else {
    editor.message(message)
  }
  return true
}

async function cleanupWithEditorBuffer(editor: Editor, buffer: BufferModel, processInfo?: MagitWithEditorProcess): Promise<void> {
  const root = processInfo?.root ?? magitRoot(buffer)
  editor.killBuffer(buffer.id)
  if (processInfo?.killStagedDiff) editor.killBuffer("*magit-diff: staged*")
  if (processInfo?.winconf) editor.restoreWindowConfiguration(processInfo.winconf)
  if (root) editor.switchToBuffer(`*magit: ${basename(root)}*`)
}

async function finalizeWithEditorProcess(editor: Editor, processInfo: MagitWithEditorProcess): Promise<MagitGitResult> {
  if (processInfo.finalized) return processInfo.done
  processInfo.finalized = true
  const result = await processInfo.done
  if (processInfo.cancelled) {
    editor.message(processInfo.cancelledMessage)
    return result
  }
  if (result.code === 0) {
    await refresh(editor, processInfo.root, processInfo.resetPoint ? 0 : undefined)
    editor.message(processInfo.successMessage)
  } else {
    editor.message(`${processInfo.failurePrefix}: ${result.err.trim() || result.code}`)
  }
  return result
}

async function recentCommitChoice(editor: Editor, root: string, prompt: string): Promise<string | null> {
  const { out } = await git(["log", "-n", "50", "--pretty=%h %s"], root, undefined, undefined, editor)
  const choices = out.split("\n").filter(Boolean)
  const selected = await editor.completingRead(prompt, { collection: choices, history: "magit-recent-commit" })
  return selected?.trim().split(/\s+/, 1)[0] ?? null
}

async function stashChoice(editor: Editor, root: string, buffer: BufferModel, prompt: string): Promise<string | null> {
  const atPoint = stashAtPoint(buffer)
  if (atPoint) return atPoint
  const { out } = await git(["stash", "list"], root, undefined, undefined, editor)
  const choices = out.split("\n").filter(Boolean)
  if (!choices.length) return null
  if (choices.length === 1) return /^stash@\{\d+\}/.exec(choices[0]!)?.[0] ?? choices[0]!.split(":", 1)[0] ?? choices[0]!
  const selected = await editor.completingRead(prompt, { collection: choices, history: "magit-stash" })
  return selected ? (/^stash@\{\d+\}/.exec(selected)?.[0] ?? selected.split(":", 1)[0] ?? selected) : null
}

async function branchOrCommitChoices(editor: Editor, root: string): Promise<string[]> {
  const { out } = await git(["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes", "refs/tags"], root, undefined, undefined, editor)
  const commits = (await git(["log", "-n", "20", "--pretty=%h %s"], root, undefined, undefined, editor)).out
    .split("\n")
    .filter(Boolean)
  return [...out.split("\n").filter(Boolean), ...commits]
}

async function resetTarget(editor: Editor, root: string, buffer: BufferModel, prompt: string, args: string[]): Promise<string | null> {
  if (args[0]) return args[0]
  const ref = refAtPoint(buffer)
  const atPoint = ref?.name ?? logShaAtPoint(buffer)
  const choices = await branchOrCommitChoices(editor, root)
  const selected = await editor.completingRead(prompt, {
    collection: choices,
    history: "magit-reset",
    initialValue: atPoint ?? "HEAD",
  })
  if (!selected) return null
  return selected.trim().split(/\s+/, 1)[0] ?? null
}

function stashPushArgs(commandArgs: readonly string[], extra: string[] = []): string[] {
  const allowed = ["--include-untracked", "--all", "--staged", "--keep-index"]
  return ["stash", "push", ...allowed.filter(arg => commandArgs.includes(arg)), ...extra]
}

const magitDispatchTransient: TransientDefinition = {
  name: "magit-dispatch",
  title: "Magit",
  groups: [
    { title: "Core", suffixes: [
      { key: "g", label: "refresh", command: "magit-refresh" },
      { key: "s", label: "stage", command: "magit-stage" },
      { key: "u", label: "unstage", command: "magit-unstage" },
      { key: "k", label: "discard", command: "magit-discard" },
      { key: "S-x", label: "reset", command: "magit-reset-popup" },
      { key: "y", label: "refs", command: "magit-show-refs" },
      { key: "tab", label: "toggle section", command: "magit-section-toggle" },
    ] },
    { title: "Prefixes", suffixes: [
      { key: "c", label: "commit", command: "magit-commit-popup" },
      { key: "b", label: "branch", command: "magit-branch-popup" },
      { key: "S-p", label: "push", command: "magit-push-popup" },
      { key: "S-f", label: "pull", command: "magit-pull-popup" },
      { key: "f", label: "fetch", command: "magit-fetch-popup" },
      { key: "l", label: "log", command: "magit-log-popup" },
      { key: "d", label: "diff", command: "magit-diff-popup" },
      { key: "z", label: "stash", command: "magit-stash-popup" },
      { key: "x", label: "reset", command: "magit-reset-popup" },
      { key: "o", label: "submodule", command: "magit-submodule-popup" },
      { key: "S-z", label: "worktree", command: "magit-worktree-popup" },
      { key: "S-b", label: "bisect", command: "magit-bisect-popup" },
      { key: "m", label: "merge", command: "magit-merge-popup" },
      { key: "r", label: "rebase", command: "magit-rebase-popup" },
      { key: "S-a", label: "cherry-pick", command: "magit-cherry-pick-popup" },
      { key: "S-v", label: "revert", command: "magit-revert-popup" },
      { key: "t", label: "tag", command: "magit-tag-popup" },
      { key: "S-m", label: "remote", command: "magit-remote-popup" },
    ] },
  ],
}

const magitCommitTransient: TransientDefinition = {
  name: "magit-commit",
  title: "Commit",
  groups: [
    { title: "Arguments", infixes: [
      { key: "- s", label: "signoff", argument: "--signoff" },
    ] },
    { title: "Actions", suffixes: [
      { key: "c", label: "commit", command: "magit-commit" },
      { key: "a", label: "amend", command: "magit-commit-amend" },
      { key: "e", label: "extend", command: "magit-commit-extend" },
      { key: "w", label: "reword", command: "magit-commit-reword" },
      { key: "f", label: "fixup", command: "magit-commit-fixup" },
      { key: "s", label: "squash", command: "magit-commit-squash" },
    ] },
  ],
}

const magitBranchTransient: TransientDefinition = {
  name: "magit-branch",
  title: "Branch",
  groups: [{ title: "Actions", suffixes: [
    { key: "b", label: "checkout", command: "magit-branch-checkout" },
    { key: "c", label: "create", command: "magit-branch-create" },
    { key: "n", label: "create", command: "magit-branch-create" },
    { key: "k", label: "delete", command: "magit-branch-delete" },
    { key: "m", label: "rename", command: "magit-branch-rename" },
  ] }],
}

const magitPushTransient: TransientDefinition = {
  name: "magit-push",
  title: "Push",
  groups: [
    { title: "Arguments", infixes: [{ key: "- u", label: "set upstream", argument: "--set-upstream" }] },
    { title: "Actions", suffixes: [
      { key: "p", label: "push", command: "magit-push" },
      { key: "u", label: "push upstream", command: "magit-push-upstream" },
    ] },
  ],
}

const magitPullTransient: TransientDefinition = {
  name: "magit-pull",
  title: "Pull",
  groups: [{ title: "Actions", suffixes: [
    { key: "u", label: "from upstream", command: "magit-pull-from-upstream" },
    { key: "p", label: "from push-remote", command: "magit-pull-from-pushremote" },
  ] }],
}

const magitFetchTransient: TransientDefinition = {
  name: "magit-fetch",
  title: "Fetch",
  groups: [{ title: "Actions", suffixes: [
    { key: "p", label: "from push-remote", command: "magit-fetch-from-pushremote" },
    { key: "u", label: "from upstream", command: "magit-fetch-from-upstream" },
    { key: "a", label: "all remotes", command: "magit-fetch-all" },
  ] }],
}

const magitLogTransient: TransientDefinition = {
  name: "magit-log",
  title: "Log",
  groups: [
    { title: "Arguments", infixes: [
      { key: "- n", label: "limit", argument: "--max-count", kind: "value", defaultValue: "", style: "equals" },
      { key: "- g", label: "graph", argument: "--graph" },
      { key: "- d", label: "decorate", argument: "--decorate" },
      { key: "- a", label: "author", argument: "--author", kind: "value", defaultValue: "", style: "equals" },
      { key: "- e", label: "grep", argument: "--grep", kind: "value", defaultValue: "", style: "equals" },
      { key: "- p", label: "patch", argument: "-p" },
      { key: "- f", label: "follow", argument: "--follow" },
    ] },
    { title: "Actions", suffixes: [
      { key: "l", label: "log current", command: "magit-log-current" },
      { key: "o", label: "log other", command: "magit-log-other" },
      { key: "a", label: "log all", command: "magit-log-all" },
    ] },
  ],
}

const magitDiffTransient: TransientDefinition = {
  name: "magit-diff",
  title: "Diff",
  groups: [
    { title: "Arguments", infixes: [
      { key: "- U", label: "context", argument: "--unified", kind: "value", defaultValue: "", style: "equals" },
      { key: "- w", label: "ignore all space", argument: "--ignore-all-space" },
      { key: "- b", label: "ignore space change", argument: "--ignore-space-change" },
      { key: "- s", label: "stat", argument: "--stat" },
      { key: "- M", label: "find renames", argument: "--find-renames" },
    ] },
    { title: "Actions", suffixes: [
      { key: "w", label: "working tree", command: "magit-diff-working-tree" },
      { key: "d", label: "working tree", command: "magit-diff-working-tree" },
      { key: "u", label: "unstaged", command: "magit-diff-unstaged" },
      { key: "s", label: "staged", command: "magit-diff-staged" },
      { key: "r", label: "range", command: "magit-diff-range" },
    ] },
  ],
}

const magitStashTransient: TransientDefinition = {
  name: "magit-stash",
  title: "Stash",
  groups: [
    { title: "Arguments", infixes: [
      { key: "- u", label: "include untracked", argument: "--include-untracked" },
      { key: "- a", label: "include ignored", argument: "--all" },
      { key: "- s", label: "staged only", argument: "--staged" },
      { key: "- k", label: "keep index", argument: "--keep-index" },
    ] },
    { title: "Actions", suffixes: [
      { key: "z", label: "stash", command: "magit-stash" },
      { key: "s", label: "stash with message", command: "magit-stash-save" },
      { key: "i", label: "stash index", command: "magit-stash-index" },
      { key: "x", label: "keep index", command: "magit-stash-keep-index" },
      { key: "p", label: "pop", command: "magit-stash-pop" },
      { key: "a", label: "apply", command: "magit-stash-apply" },
      { key: "k", label: "drop", command: "magit-stash-drop" },
      { key: "l", label: "list", command: "magit-stash-list" },
      { key: "v", label: "show", command: "magit-stash-show" },
      { key: "b", label: "branch", command: "magit-stash-branch" },
    ] },
  ],
}

const magitResetTransient: TransientDefinition = {
  name: "magit-reset",
  title: "Reset",
  groups: [{ title: "Actions", suffixes: [
    { key: "x", label: "reset index", command: "magit-reset" },
    { key: "m", label: "mixed", command: "magit-reset-mixed" },
    { key: "s", label: "soft", command: "magit-reset-soft" },
    { key: "h", label: "hard", command: "magit-reset-hard" },
    { key: "k", label: "keep", command: "magit-reset-keep" },
    { key: "i", label: "index", command: "magit-reset-index" },
    { key: "w", label: "worktree", command: "magit-reset-worktree" },
  ] }],
}

const magitSubmoduleTransient: TransientDefinition = {
  name: "magit-submodule",
  title: "Submodule",
  groups: [
    { title: "Arguments", infixes: [
      { key: "- f", label: "force", argument: "--force" },
      { key: "- r", label: "recursive", argument: "--recursive" },
      { key: "- N", label: "no fetch", argument: "--no-fetch" },
      { key: "- U", label: "remote", argument: "--remote" },
    ] },
    { title: "Actions", suffixes: [
      { key: "a", label: "add", command: "magit-submodule-add" },
      { key: "i", label: "init", command: "magit-submodule-init" },
      { key: "u", label: "update", command: "magit-submodule-update" },
      { key: "s", label: "sync", command: "magit-submodule-sync" },
      { key: "d", label: "deinit", command: "magit-submodule-deinit" },
    ] },
  ],
}

const magitWorktreeTransient: TransientDefinition = {
  name: "magit-worktree",
  title: "Worktree",
  groups: [
    { title: "Create new", suffixes: [
      { key: "b", label: "worktree", command: "magit-worktree-checkout" },
      { key: "c", label: "branch and worktree", command: "magit-worktree-branch" },
    ] },
    { title: "Commands", suffixes: [
      { key: "g", label: "visit", command: "magit-worktree-status" },
      { key: "k", label: "delete", command: "magit-worktree-delete" },
    ] },
  ],
}

const magitMergeTransient: TransientDefinition = {
  name: "magit-merge",
  title: "Merge",
  groups: [{ title: "Actions", suffixes: [
    { key: "m", label: "merge", command: "magit-merge" },
    { key: "a", label: "abort", command: "magit-merge-abort" },
  ] }],
}

const magitRebaseTransient: TransientDefinition = {
  name: "magit-rebase",
  title: "Rebase",
  groups: [{ title: "Actions", suffixes: [
    { key: "r", label: "continue", command: "magit-rebase-continue" },
    { key: "c", label: "continue", command: "magit-rebase-continue" },
    { key: "s", label: "skip", command: "magit-rebase-skip" },
    { key: "a", label: "abort", command: "magit-rebase-abort" },
    { key: "e", label: "rebase", command: "magit-rebase" },
    { key: "i", label: "interactive", command: "magit-rebase-interactive" },
  ] }],
}

const magitCherryPickTransient: TransientDefinition = {
  name: "magit-cherry-pick",
  title: "Cherry-pick",
  groups: [{ title: "Actions", suffixes: [
    { key: "a", label: "cherry-pick", command: "magit-cherry-pick" },
    { key: "s", label: "skip", command: "magit-cherry-pick-skip" },
    { key: "S-a", label: "abort", command: "magit-cherry-pick-abort" },
  ] }],
}

const magitRevertTransient: TransientDefinition = {
  name: "magit-revert",
  title: "Revert",
  groups: [{ title: "Actions", suffixes: [
    { key: "v", label: "revert", command: "magit-revert" },
    { key: "a", label: "abort", command: "magit-revert-abort" },
  ] }],
}

const magitTagTransient: TransientDefinition = {
  name: "magit-tag",
  title: "Tag",
  groups: [{ title: "Actions", suffixes: [
    { key: "t", label: "create", command: "magit-tag" },
    { key: "k", label: "delete", command: "magit-tag-delete" },
  ] }],
}

const magitRemoteTransient: TransientDefinition = {
  name: "magit-remote",
  title: "Remote",
  groups: [{ title: "Actions", suffixes: [
    { key: "a", label: "add", command: "magit-remote-add" },
    { key: "k", label: "remove", command: "magit-remote-remove" },
    { key: "r", label: "rename", command: "magit-remote-rename" },
  ] }],
}

const magitFileTransient: TransientDefinition = {
  name: "magit-file",
  title: "File",
  groups: [{ title: "Actions", suffixes: [
    { key: "i", label: "intent-to-add", command: "magit-stage-intent-to-add" },
    { key: "u", label: "untrack", command: "magit-file-untrack" },
  ] }],
}

const magitBisectTransient: TransientDefinition = {
  name: "magit-bisect",
  title: "Bisect",
  groups: [{ title: "Actions", suffixes: [
    { key: "s", label: "start", command: "magit-bisect-start" },
    { key: "g", label: "good", command: "magit-bisect-good" },
    { key: "b", label: "bad", command: "magit-bisect-bad" },
    { key: "k", label: "skip", command: "magit-bisect-skip" },
    { key: "r", label: "reset", command: "magit-bisect-reset" },
  ] }],
}

function defineTransientCommand(editor: Editor, command: string, definition: TransientDefinition, description: string): void {
  editor.command(command, ({ editor }) => editor.openTransient(definition), description)
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  installMagitSection(editor)
  defcustom<null | "t" | "all">(
    "magit-diff-refine-hunk",
    "sexp",
    null,
    "Whether Magit diff hunks receive word-level intra-line highlighting: nil, t, or all.",
    "magit",
  )
  defcustom<boolean>(
    "magit-refs-show-commit-count",
    "boolean",
    true,
    "Whether the Magit refs buffer shows ahead/behind counts relative to HEAD.",
    "magit",
  )

  const magitModeMap = new Keymap("magit-mode-map")
  magitModeMap.bind("return", "magit-visit-thing")
  magitModeMap.bind("RET", "magit-visit-thing")
  magitModeMap.bind("space", "magit-diff-show-or-scroll-up")
  magitModeMap.bind("S-space", "magit-diff-show-or-scroll-down")
  magitModeMap.bind("backspace", "magit-diff-show-or-scroll-down")
  magitModeMap.bind("+", "magit-diff-more-context")
  magitModeMap.bind("-", "magit-diff-less-context")
  magitModeMap.bind("0", "magit-diff-default-context")
  magitModeMap.bind("d", "magit-diff-popup")
  magitModeMap.bind("S-b", "magit-bisect-popup")
  magitModeMap.bind("S-d", "magit-diff-refresh")
  magitModeMap.bind("g", "magit-refresh")
  magitModeMap.bind("S-g", "magit-refresh-all")
  magitModeMap.bind("h", "magit-dispatch")
  magitModeMap.bind("?", "magit-dispatch")
  magitModeMap.bind("y", "magit-show-refs")
  magitModeMap.bind("o", "magit-submodule-popup")
  magitModeMap.bind("S-z", "magit-worktree-popup")
  magitModeMap.bind("q", "magit-bury-buffer")
  magitModeMap.bind(":", "magit-git-command")
  magitModeMap.bind("$", "magit-process")
  magitModeMap.bind("tab", "magit-section-toggle")
  defineMode({ name: "magit-mode", parent: "magit-section-mode", keymap: magitModeMap })

  const magitDiffModeMap = new Keymap("magit-diff-mode-map")
  magitDiffModeMap.bind("C-c C-d", "magit-diff-while-committing")
  magitDiffModeMap.bind("C-c C-b", "magit-go-backward")
  magitDiffModeMap.bind("C-c C-f", "magit-go-forward")
  magitDiffModeMap.bind("C-x C-w", "magit-patch-save")
  magitDiffModeMap.bind("space", "scroll-up-command")
  magitDiffModeMap.bind("S-space", "scroll-down-command")
  magitDiffModeMap.bind("backspace", "scroll-down-command")
  magitDiffModeMap.bind("j", "magit-jump-to-diffstat-or-diff")
  defineMode({ name: "magit-diff-mode", parent: "magit-mode", keymap: magitDiffModeMap, fontLock: magitDiffFontLock })

  const statusMap = new Keymap("magit-status-map")
  // magit-mode-map parity: single keys + transient prefix sequences (c c, P p, …).
  // Shifted letters MUST be bound as `S-<lower>`: normalizeToken lowercases a
  // bare uppercase letter, so e.g. `S` would clobber `s` (t-26dfa2ae).
  statusMap.bind("return", "magit-visit-thing")
  statusMap.bind("RET", "magit-visit-thing")
  statusMap.bind("s", "magit-stage")
  statusMap.bind("S-s", "magit-stage-modified")
  statusMap.bind("u", "magit-unstage")
  statusMap.bind("S-u", "magit-unstage-all")
  statusMap.bind("g", "magit-refresh")
  statusMap.bind("S-g", "magit-refresh-all")
  statusMap.bind("k", "magit-discard")
  statusMap.bind("S-x m", "magit-reset-mixed")
  statusMap.bind("S-x s", "magit-reset-soft")
  statusMap.bind("S-x h", "magit-reset-hard")
  statusMap.bind("c c", "magit-commit")
  statusMap.bind("c a", "magit-commit-amend")
  statusMap.bind("S-p p", "magit-push")
  statusMap.bind("S-p u", "magit-push-upstream")
  statusMap.bind("l l", "magit-log-current")
  statusMap.bind("l o", "magit-log-other")
  statusMap.bind("l a", "magit-log-all")
  statusMap.bind("S-l l", "magit-log-refresh")
  statusMap.bind("b b", "magit-branch-checkout")
  statusMap.bind("b c", "magit-branch-create")
  statusMap.bind("b n", "magit-branch-create")
  statusMap.bind("b k", "magit-branch-delete")
  statusMap.bind("b m", "magit-branch-rename")
  statusMap.bind("z z", "magit-stash")
  statusMap.bind("z p", "magit-stash-pop")
  statusMap.bind("z a", "magit-stash-apply")
  statusMap.bind("z k", "magit-stash-drop")
  statusMap.bind("z l", "magit-stash-list")
  statusMap.bind("z s", "magit-stash-save")
  statusMap.bind("z i", "magit-stash-index")
  statusMap.bind("z x", "magit-stash-keep-index")
  statusMap.bind("z v", "magit-stash-show")
  statusMap.bind("z b", "magit-stash-branch")
  statusMap.bind("a", "magit-stash-show")
  statusMap.bind("S-b s", "magit-bisect-start")
  statusMap.bind("S-b g", "magit-bisect-good")
  statusMap.bind("S-b b", "magit-bisect-bad")
  statusMap.bind("S-b k", "magit-bisect-skip")
  statusMap.bind("S-b r", "magit-bisect-reset")
  statusMap.bind("m m", "magit-merge")
  statusMap.bind("m a", "magit-merge-abort")
  statusMap.bind("r r", "magit-rebase-continue")
  statusMap.bind("r c", "magit-rebase-continue")
  statusMap.bind("r s", "magit-rebase-skip")
  statusMap.bind("r a", "magit-rebase-abort")
  statusMap.bind("r e", "magit-rebase")
  statusMap.bind("r i", "magit-rebase-interactive")
  statusMap.bind("S-a a", "magit-cherry-pick")
  statusMap.bind("S-a s", "magit-cherry-pick-skip")
  statusMap.bind("S-a S-a", "magit-cherry-pick-abort")
  statusMap.bind("S-v v", "magit-revert")
  statusMap.bind("S-v a", "magit-revert-abort")
  statusMap.bind("t t", "magit-tag")
  statusMap.bind("t k", "magit-tag-delete")
  statusMap.bind("S-m a", "magit-remote-add")
  statusMap.bind("S-m k", "magit-remote-remove")
  statusMap.bind("S-m r", "magit-remote-rename")
  statusMap.bind("o a", "magit-submodule-add")
  statusMap.bind("o i", "magit-submodule-init")
  statusMap.bind("o u", "magit-submodule-update")
  statusMap.bind("o s", "magit-submodule-sync")
  statusMap.bind("o d", "magit-submodule-deinit")
  statusMap.bind("S-z b", "magit-worktree-checkout")
  statusMap.bind("S-z c", "magit-worktree-branch")
  statusMap.bind("S-z g", "magit-worktree-status")
  statusMap.bind("S-z k", "magit-worktree-delete")
  statusMap.bind("y", "magit-show-refs")
  statusMap.bind("c e", "magit-commit-extend")
  statusMap.bind("c w", "magit-commit-reword")
  statusMap.bind("c f", "magit-commit-fixup")
  statusMap.bind("c s", "magit-commit-squash")
  statusMap.bind("d d", "magit-diff-working")
  statusMap.bind("d w", "magit-diff-working-tree")
  statusMap.bind("d u", "magit-diff-unstaged")
  statusMap.bind("d s", "magit-diff-staged")
  statusMap.bind("d r", "magit-diff-range")
  statusMap.bind("n", "magit-section-forward")
  statusMap.bind("p", "magit-section-backward")
  statusMap.bind("f p", "magit-fetch-from-pushremote")
  statusMap.bind("f u", "magit-fetch-from-upstream")
  statusMap.bind("f a", "magit-fetch-all")
  statusMap.bind("S-f u", "magit-pull-from-upstream")
  statusMap.bind("S-f p", "magit-pull-from-pushremote")
  statusMap.bind("h", "magit-dispatch")
  statusMap.bind("?", "magit-dispatch")
  statusMap.bind("j s", "magit-jump-to-staged")
  statusMap.bind("j u", "magit-jump-to-unstaged")
  statusMap.bind("j z", "magit-jump-to-stashes")
  statusMap.bind("S-i", "magit-init")
  statusMap.bind(":", "magit-git-command")
  statusMap.bind("$", "magit-process")
  statusMap.bind("q", "magit-bury-buffer")
  statusMap.bind("tab", "magit-section-toggle")
  statusMap.bind("c", "magit-commit-popup", { eager: true })
  statusMap.bind("b", "magit-branch-popup", { eager: true })
  statusMap.bind("S-p", "magit-push-popup", { eager: true })
  statusMap.bind("S-f", "magit-pull-popup", { eager: true })
  statusMap.bind("f", "magit-fetch-popup", { eager: true })
  statusMap.bind("l", "magit-log-popup", { eager: true })
  statusMap.bind("d", "magit-diff-popup", { eager: true })
  statusMap.bind("z", "magit-stash-popup", { eager: true })
  statusMap.bind("x", "magit-reset-popup", { eager: true })
  statusMap.bind("S-x", "magit-file-popup", { eager: true })
  statusMap.bind("o", "magit-submodule-popup", { eager: true })
  statusMap.bind("S-z", "magit-worktree-popup", { eager: true })
  statusMap.bind("S-b", "magit-bisect-popup", { eager: true })
  statusMap.bind("m", "magit-merge-popup", { eager: true })
  statusMap.bind("r", "magit-rebase-popup", { eager: true })
  statusMap.bind("S-a", "magit-cherry-pick-popup", { eager: true })
  statusMap.bind("S-v", "magit-revert-popup", { eager: true })
  statusMap.bind("t", "magit-tag-popup", { eager: true })
  statusMap.bind("S-m", "magit-remote-popup", { eager: true })
  defineMode({ name: "magit-status", parent: "magit-mode", keymap: statusMap, fontLock: magitDiffFontLock })

  const commitMap = new Keymap("magit-commit-map")
  commitMap.bind("C-c C-c", "magit-commit-finish")
  commitMap.bind("C-c C-d", "magit-diff-while-committing")
  commitMap.bind("C-c C-k", "magit-commit-abort")
  defineMode({ name: "magit-commit", parent: "text", keymap: commitMap, commentStart: "#", fontLock: gitCommitFontLock })

  const processMap = new Keymap("magit-process-mode-map")
  processMap.bind("g", "magit-refresh")
  processMap.bind("q", "magit-bury-buffer")
  defineMode({ name: "magit-process-mode", parent: "magit-mode", keymap: processMap, fontLock: magitDiffFontLock })

  const rebaseTodoMap = new Keymap("git-rebase-mode-map")
  rebaseTodoMap.bind("p", "git-rebase-pick")
  rebaseTodoMap.bind("r", "git-rebase-reword")
  rebaseTodoMap.bind("e", "git-rebase-edit")
  rebaseTodoMap.bind("s", "git-rebase-squash")
  rebaseTodoMap.bind("f", "git-rebase-fixup")
  rebaseTodoMap.bind("k", "git-rebase-drop")
  rebaseTodoMap.bind("C-k", "git-rebase-drop")
  rebaseTodoMap.bind("M-up", "git-rebase-move-line-up")
  rebaseTodoMap.bind("M-down", "git-rebase-move-line-down")
  rebaseTodoMap.bind("C-c C-c", "git-rebase-finish")
  rebaseTodoMap.bind("C-c C-k", "git-rebase-abort")
  defineMode({ name: "git-rebase-mode", parent: "text", keymap: rebaseTodoMap })

  const logMap = new Keymap("magit-log-map")
  logMap.bind("return", "magit-log-show-commit")
  logMap.bind("RET", "magit-log-show-commit")
  logMap.bind("g", "magit-log")
  logMap.bind("q", "magit-bury-buffer")
  defineMode({ name: "magit-log", parent: "magit-mode", keymap: logMap, fontLock: magitDiffFontLock })

  const refsMap = new Keymap("magit-refs-mode-map")
  refsMap.bind("return", "magit-visit-thing")
  refsMap.bind("RET", "magit-visit-thing")
  refsMap.bind("g", "magit-refresh")
  refsMap.bind("k", "magit-branch-delete")
  refsMap.bind("b b", "magit-branch-checkout")
  refsMap.bind("q", "magit-bury-buffer")
  defineMode({ name: "magit-refs-mode", parent: "magit-mode", keymap: refsMap, fontLock: magitDiffFontLock })

  const revisionMap = new Keymap("magit-revision-mode-map")
  revisionMap.bind("j", "magit-revision-jump")
  revisionMap.bind("q", "magit-bury-buffer")
  defineMode({ name: "magit-revision-mode", parent: "magit-diff-mode", keymap: revisionMap, fontLock: magitDiffFontLock })

  const blameMap = new Keymap("magit-blame-mode-map")
  blameMap.bind("return", "magit-blame-show-commit")
  blameMap.bind("RET", "magit-blame-show-commit")
  blameMap.bind("n", "magit-blame-next-chunk")
  blameMap.bind("p", "magit-blame-previous-chunk")
  blameMap.bind("q", "magit-blame-quit")
  defineMode({ name: "magit-blame-mode", parent: "magit-mode", keymap: blameMap })

  editor.command("magit-blame", async ({ buffer, editor }) => {
    const path = buffer.path
    if (!path || buffer.kind === "directory") {
      editor.message("Buffer is not visiting a file")
      return
    }
    const dir = path.slice(0, path.lastIndexOf("/")) || "/"
    const rootResult = await git(["rev-parse", "--show-toplevel"], dir, undefined, undefined, editor)
    const root = rootResult.out.trim()
    if (rootResult.code !== 0 || !root) {
      editor.message("Not in a git repository")
      return
    }
    const { out, err, code } = await git(["blame", "--line-porcelain", "--", path], root, undefined, undefined, editor)
    if (code !== 0) {
      editor.message(`git blame failed: ${err.trim() || code}`)
      return
    }
    const chunks = parseBlamePorcelain(out)
    if (!chunks.length) {
      editor.message("No blame information")
      return
    }
    const { text, lineShas } = renderBlame(chunks)
    const sourceLine = buffer.text.slice(0, buffer.point).split("\n").length - 1
    const buf = editor.displayBufferInOtherWindow(
      editor.scratch(`*magit-blame: ${path.split("/").pop()}*`, text, "magit-blame-mode").id,
      { select: true },
    )
    buf.readOnly = true
    buf.locals.set("magit-root", root)
    buf.locals.set(BLAME_SHAS_LOCAL, lineShas)
    const lines = text.split("\n")
    let offset = 0
    for (let i = 0; i < Math.min(sourceLine, lines.length - 1); i++) offset += lines[i]!.length + 1
    buf.point = offset
  }, "Show git blame for the current file in a magit-blame buffer.")

  editor.command("magit-blame-show-commit", async ({ buffer, editor }) => {
    const sha = blameShaAtPoint(buffer)
    const root = magitRoot(buffer)
    if (!sha || !root) {
      editor.message("No commit at point")
      return
    }
    await showRevision(editor, root, sha)
  }, "Show the commit blamed for the line at point.")

  editor.command("magit-blame-next-chunk", ({ buffer, editor }) => {
    const target = blameChunkTarget(buffer, 1)
    if (target == null) editor.message("No next chunk")
    else buffer.point = target
  }, "Move to the next blame chunk.")

  editor.command("magit-blame-previous-chunk", ({ buffer, editor }) => {
    const target = blameChunkTarget(buffer, -1)
    if (target == null) editor.message("No previous chunk")
    else buffer.point = target
  }, "Move to the previous blame chunk.")

  editor.command("magit-blame-quit", ({ buffer, editor }) => {
    if (buffer.mode === "magit-blame-mode") editor.killBuffer(buffer.id)
    else editor.message("Not in a magit-blame buffer")
  }, "Kill the magit-blame buffer.")

  editor.command("magit-undefined", ({ editor }) => {
    editor.message("Buffer is read-only")
  }, "No-op for unbound printable keys in read-only Magit buffers.")

  editor.command("magit-diff-show-or-scroll-up", async ({ editor }) => {
    await editor.run("scroll-up-command")
  }, "Show the section at point or scroll up.")

  editor.command("magit-diff-show-or-scroll-down", async ({ editor }) => {
    await editor.run("scroll-down-command")
  }, "Show the section at point or scroll down.")

  editor.command("magit-diff-more-context", async ({ editor, buffer, prefixArgument }) => {
    const next = magitDiffContext(buffer) + prefixCount(prefixArgument)
    if (!(await refreshDiffBuffer(editor, buffer, next))) editor.message("Cannot change diff context in this buffer")
  }, "Increase the context for diff hunks.")

  editor.command("magit-diff-less-context", async ({ editor, buffer, prefixArgument }) => {
    const next = Math.max(0, magitDiffContext(buffer) - prefixCount(prefixArgument))
    if (!(await refreshDiffBuffer(editor, buffer, next))) editor.message("Cannot change diff context in this buffer")
  }, "Decrease the context for diff hunks.")

  editor.command("magit-diff-default-context", async ({ editor, buffer }) => {
    if (!(await refreshDiffBuffer(editor, buffer, DEFAULT_DIFF_CONTEXT))) editor.message("Cannot change diff context in this buffer")
  }, "Reset context for diff hunks to the default height.")

  editor.command("magit-diff-refresh", ({ editor }) => {
    editor.openTransient(magitDiffTransient)
  }, "Change the diff arguments used for the current buffer.")

  editor.command("magit-patch-save", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root || !modeDerivesFrom(buffer.mode, "magit-diff-mode")) return editor.message("Only diff buffers can be saved as patches")
    const file = args[0] ?? await editor.prompt("Write patch file: ", join(root, "magit.patch"), "magit-patch-save")
    if (!file) return
    const diffArgs = magitDiffBaseArgs(buffer)
    const patch = diffArgs ? (await git(withDiffOptions(diffArgs, [...magitDiffContextArgs(magitDiffContext(buffer)), "-p"]), root, undefined, undefined, editor)).out : buffer.text
    const target = isAbsolute(file) ? file : join(root, file)
    if (existsSync(target)) {
      const ans = await editor.prompt(`File ${target} exists; overwrite? (y or n) `)
      if (ans !== "y") return editor.message("Cancelled")
    }
    await writeFile(target, patch)
    editor.message(`Wrote ${target}`)
    await refreshDiffBuffer(editor, buffer, magitDiffContext(buffer))
  }, "Write the current Magit diff into a patch file.")

  editor.command("magit-diff-while-committing", async ({ editor }) => {
    const commitBuffer = commitMessageBuffer(editor)
    if (!commitBuffer) return editor.message("No commit in progress")
    await showCommitDiff(editor, commitBuffer)
  }, "While committing, show the changes that are about to be committed.")

  editor.command("magit-go-backward", ({ editor, buffer }) => {
    if (!magitGo(editor, buffer, "backward")) editor.message("No previous entry in buffer's history")
  }, "Move backward in current buffer's history.")

  editor.command("magit-go-forward", ({ editor, buffer }) => {
    if (!magitGo(editor, buffer, "forward")) editor.message("No next entry in buffer's history")
  }, "Move forward in current buffer's history.")

  editor.command("magit-jump-to-diffstat-or-diff", ({ buffer }) => {
    const diff = buffer.text.indexOf("diff --git ")
    const hunk = buffer.text.indexOf("@@")
    const target = diff >= 0 ? diff : hunk
    if (target >= 0) buffer.point = target
  }, "Jump to the diffstat or diff in the current Magit diff buffer.")

  editor.command("magit-revision-jump", ({ buffer }) => {
    const diff = buffer.text.indexOf("diff --git ")
    if (diff >= 0) buffer.point = diff
  }, "Jump within the current Magit revision buffer.")

  defineTransientCommand(editor, "magit-dispatch", magitDispatchTransient, "Show the Magit dispatch popup.")
  defineTransientCommand(editor, "magit-commit-popup", magitCommitTransient, "Show the Magit commit popup.")
  defineTransientCommand(editor, "magit-branch-popup", magitBranchTransient, "Show the Magit branch popup.")
  defineTransientCommand(editor, "magit-push-popup", magitPushTransient, "Show the Magit push popup.")
  defineTransientCommand(editor, "magit-pull-popup", magitPullTransient, "Show the Magit pull popup.")
  defineTransientCommand(editor, "magit-fetch-popup", magitFetchTransient, "Show the Magit fetch popup.")
  defineTransientCommand(editor, "magit-log-popup", magitLogTransient, "Show the Magit log popup.")
  defineTransientCommand(editor, "magit-diff-popup", magitDiffTransient, "Show the Magit diff popup.")
  defineTransientCommand(editor, "magit-stash-popup", magitStashTransient, "Show the Magit stash popup.")
  defineTransientCommand(editor, "magit-reset-popup", magitResetTransient, "Show the Magit reset popup.")
  defineTransientCommand(editor, "magit-bisect-popup", magitBisectTransient, "Show the Magit bisect popup.")
  defineTransientCommand(editor, "magit-merge-popup", magitMergeTransient, "Show the Magit merge popup.")
  defineTransientCommand(editor, "magit-rebase-popup", magitRebaseTransient, "Show the Magit rebase popup.")
  defineTransientCommand(editor, "magit-cherry-pick-popup", magitCherryPickTransient, "Show the Magit cherry-pick popup.")
  defineTransientCommand(editor, "magit-revert-popup", magitRevertTransient, "Show the Magit revert popup.")
  defineTransientCommand(editor, "magit-tag-popup", magitTagTransient, "Show the Magit tag popup.")
  defineTransientCommand(editor, "magit-remote-popup", magitRemoteTransient, "Show the Magit remote popup.")
  defineTransientCommand(editor, "magit-file-popup", magitFileTransient, "Show the Magit file popup.")
  defineTransientCommand(editor, "magit-submodule-popup", magitSubmoduleTransient, "Show the Magit submodule popup.")
  defineTransientCommand(editor, "magit-worktree-popup", magitWorktreeTransient, "Show the Magit worktree popup.")

  editor.command("magit-status", async ({ editor, buffer, args }) => {
    const start = args[0] ?? buffer.directory() ?? process.cwd()
    const root = await projectRoot(start)
    if (!root) {
      editor.message(`Not inside a Git repository: ${start}`)
      return
    }
    await refresh(editor, root)
  }, "Open the Magit status buffer for the current repository.")

  editor.command("magit-refresh", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.run("magit-status")
    if (buffer.mode === "magit-refs-mode") {
      await openRefs(editor, root, undefined, buffer.point)
      return
    }
    await refresh(editor, root)
  }, "Refresh the current Magit status buffer.")

  editor.command("magit-show-refs", async ({ editor, buffer }) => {
    const root = magitRoot(buffer) ?? await projectRoot(buffer.directory() ?? process.cwd())
    if (!root) return editor.message("Not inside a Git repository")
    await openRefs(editor, root, buffer)
  }, "Show branches, remote branches, and tags in a Magit refs buffer.")

  editor.command("magit-stage", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) {
      editor.message("Nothing to stage at point")
      return
    }
    const hunk = hunkAtPoint(buffer)
    if (hunk && !hunk.staged) {
      const patch = partialPatchForRegion(buffer, hunk) ?? hunk.patch
      const partial = patch !== hunk.patch
      const { err, code } = await git(["apply", "--cached", "-"], root, patch, undefined, editor)
      if (code !== 0) {
        editor.message(`git apply failed: ${err.trim()}`)
        return
      }
      await refresh(editor, root)
      editor.message(`Staged ${partial ? "selected lines" : "hunk"} in ${hunk.file}`)
      return
    }
    const entry = entryAtPoint(buffer)
    if (!entry || entry.staged) {
      editor.message("Nothing to stage at point")
      return
    }
    await git(["add", "--", ...entryPathspecs(entry)], root, undefined, undefined, editor)
    await refresh(editor, root)
    editor.message(`Staged ${fileDisplayName(entry)}`)
  }, "Stage the hunk or file at point.")

  editor.command("magit-unstage", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) {
      editor.message("Nothing to unstage at point")
      return
    }
    const hunk = hunkAtPoint(buffer)
    if (hunk && hunk.staged) {
      const patch = partialPatchForRegion(buffer, hunk) ?? hunk.patch
      const partial = patch !== hunk.patch
      const { err, code } = await git(["apply", "--cached", "--reverse", "-"], root, patch, undefined, editor)
      if (code !== 0) {
        editor.message(`git apply failed: ${err.trim()}`)
        return
      }
      await refresh(editor, root)
      editor.message(`Unstaged ${partial ? "selected lines" : "hunk"} in ${hunk.file}`)
      return
    }
    const entry = entryAtPoint(buffer)
    if (!entry || !entry.staged) {
      editor.message("Nothing to unstage at point")
      return
    }
    await git(["restore", "--staged", "--", ...entryPathspecs(entry)], root, undefined, undefined, editor)
    await refresh(editor, root)
    editor.message(`Unstaged ${fileDisplayName(entry)}`)
  }, "Unstage the hunk or file at point.")

  editor.command("magit-commit", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) {
      editor.message("Not in a Magit buffer")
      return
    }
    const signoff = args.includes("--signoff") ? ["--signoff"] : []
    const editBuffer = await startGitWithEditorFlow(editor, root, ["commit", ...signoff], {
      successMessage: "Committed",
      failurePrefix: "git commit failed",
      cancelledMessage: "Commit aborted",
      showCommitDiff: true,
      awaitOnFinish: true,
    })
    if (editBuffer) editor.message("Type C-c C-c to finish, C-c C-k to abort")
  }, "Open a buffer to write a commit message for staged changes.")

  editor.command("magit-commit-finish", async ({ editor, buffer }) => {
    if (await finishWithEditorBuffer(editor, buffer)) return
    const root = magitRoot(buffer)
    if (!root || buffer.mode !== "magit-commit") {
      editor.message("Not in a commit message buffer")
      return
    }
    const msg = buffer.text
    if (!msg.trim()) {
      editor.message("Aborting commit due to empty message")
      return
    }
    const extra = (buffer.locals.get("magit-commit-args") as string[] | undefined) ?? []
    const { err, code } = await git(["commit", ...extra.filter(arg => arg === "--signoff"), "-F", "-"], root, msg, undefined, editor)
    if (code !== 0) {
      editor.message(`git commit failed: ${err.trim()}`)
      return
    }
    const winconf = buffer.locals.get("magit-winconf") as ReturnType<Editor["currentWindowConfiguration"]> | undefined
    editor.killBuffer(buffer.id)
    editor.killBuffer("*magit-diff: staged*")
    if (winconf) editor.restoreWindowConfiguration(winconf)
    await refresh(editor, root, 0)
    editor.message("Committed")
  }, "Finish the commit using the current buffer as the message.")

  editor.command("magit-commit-abort", async ({ editor, buffer }) => {
    if (isWithEditorBuffer(buffer)) {
      await abortWithEditorEdit(editor, buffer, buffer.mode === "git-rebase-mode" ? "Interactive rebase aborted" : "Commit aborted")
      return
    }
    if (buffer.mode !== "magit-commit") {
      editor.message("Not in a commit message buffer")
      return
    }
    const root = magitRoot(buffer)
    const winconf = buffer.locals.get("magit-winconf") as ReturnType<Editor["currentWindowConfiguration"]> | undefined
    editor.killBuffer(buffer.id)
    editor.killBuffer("*magit-diff: staged*")
    if (winconf) editor.restoreWindowConfiguration(winconf)
    if (root) editor.switchToBuffer(`*magit: ${basename(root)}*`)
    editor.message("Commit aborted")
  }, "Abort the commit message buffer without committing.")

  editor.command("magit-push", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) {
      editor.message("Not in a Magit buffer")
      return
    }
    const { out } = await git(["rev-parse", "--abbrev-ref", "HEAD"], root, undefined, undefined, editor)
    const current = out.trim() || "HEAD"
    const setUpstream = args.includes("--set-upstream")
    const explicit = args.filter(arg => arg !== "--set-upstream")
    const remote = explicit[0] ?? await editor.prompt("Push to remote: ", "origin", "magit-push-remote")
    if (remote == null) return
    const branch = explicit[1] ?? await editor.prompt("Push branch: ", current, "magit-push-branch")
    if (branch == null) return
    const { err, code } = await git(["push", ...(setUpstream ? ["--set-upstream"] : []), refname(remote), refname(branch)], root, undefined, undefined, editor)
    if (code !== 0) {
      editor.message(`git push failed: ${err.trim()}`)
      return
    }
    await refresh(editor, root)
    editor.message(`Pushed ${branch} to ${remote}`)
  }, "Push the current branch, prompting for remote and branch.")

  editor.command("magit-log", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) {
      editor.message("Not in a Magit buffer")
      return
    }
    const pathspec = buffer.locals.get("magit-log-file") as string | undefined
    const all = buffer.locals.get("magit-log-all") === true
    const branch = buffer.locals.get("magit-log-branch") as string | undefined
    await openLog(editor, root, buffer, {
      args: args.length ? args : magitLogStoredArgs(buffer),
      pathspec,
      all,
      branch,
    })
  }, "Refresh or show recent history in a *magit-log* buffer.")

  editor.command("magit-log-current", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) {
      editor.message("Not in a Magit buffer")
      return
    }
    const pathspec = buffer.locals.get("magit-log-file") as string | undefined
    await openLog(editor, root, buffer, { args, pathspec })
  }, "Show recent history for the current branch.")

  editor.command("magit-log-other", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const parsed = parseMagitLogArgs(args)
    const { out } = await git(["branch", "-a", "--format=%(refname:short)"], root, undefined, undefined, editor)
    const branches = out.split("\n").filter(Boolean)
    const branch = parsed.revs[0] ?? await editor.completingRead("Log branch: ", { collection: branches, history: "magit-log-branch" })
    if (!branch) return
    await openLog(editor, root, buffer, { args, branch })
  }, "Show recent history for another branch.")

  editor.command("magit-log-all", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    await openLog(editor, root, buffer, { args, all: true })
  }, "Show recent history for all refs.")

  editor.command("magit-log-buffer-file", async ({ editor, buffer, args }) => {
    const path = buffer.path
    if (!path || buffer.kind === "directory") {
      editor.message("Buffer is not visiting a file")
      return
    }
    const root = await repositoryRootForFile(path)
    if (!root) return editor.message("Not in a git repository")
    await openLog(editor, root, buffer, { args, pathspec: await repoRelativePath(root, path) })
  }, "Show recent history for the current file in a *magit-log* buffer.")

  editor.command("magit-show-commit", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    const rev = args[0] ?? commitishAtPoint(buffer)
    if (!root || !rev) return editor.message("No commit at point")
    await showRevision(editor, root, rev, buffer)
  }, "Show the commit or stash at point in a revision buffer.")

  editor.command("magit-log-show-commit", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    const sha = commitishAtPoint(buffer)
    if (!root || !sha) {
      editor.message("No commit at point")
      return
    }
    const logWindow = editor.selectedWindowId
    editor.splitWindowBelow()
    editor.selectWindow(nextWindowId(editor.windowLayout, editor.selectedWindowId, 1))
    await showRevision(editor, root, sha, buffer)
    editor.selectWindow(logWindow)
  }, "Show the commit at point in a split below, keeping the log selected.")

  editor.command("magit-branch-checkout", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) {
      editor.message("Not in a Magit buffer")
      return
    }
    const ref = refAtPoint(buffer)
    const { out } = await git(["branch", "-a", "--format=%(refname:short)"], root, undefined, undefined, editor)
    const branches = out.split("\n").filter(Boolean)
    const target = args[0] ?? (ref?.kind === "local" || ref?.kind === "remote" ? ref.name : null)
      ?? await editor.completingRead("Checkout branch: ", { collection: branches, history: "magit-branch" })
    if (!target) return
    const { err, code } = await git(["checkout", refname(target)], root, undefined, undefined, editor)
    if (code !== 0) {
      editor.message(`git checkout failed: ${err.trim()}`)
      return
    }
    await refresh(editor, root, 0)
    editor.message(`Checked out ${target}`)
  }, "Checkout an existing branch.")

  editor.command("magit-branch-create", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) {
      editor.message("Not in a Magit buffer")
      return
    }
    const name = args[0] ?? await editor.prompt("Create and checkout branch: ", "", "magit-branch")
    if (!name) return
    const { err, code } = await git(["checkout", "-b", refname(name)], root, undefined, undefined, editor)
    if (code !== 0) {
      editor.message(`git checkout -b failed: ${err.trim()}`)
      return
    }
    await refresh(editor, root, 0)
    editor.message(`Created and checked out ${name}`)
  }, "Create and checkout a new branch.")

  editor.command("magit-stash", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) {
      editor.message("Not in a Magit buffer")
      return
    }
    const { out, err, code } = await git(stashPushArgs(args), root, undefined, undefined, editor)
    if (code !== 0) {
      editor.message(`git stash failed: ${err.trim()}`)
      return
    }
    await refresh(editor, root, 0)
    editor.message(out.trim() || "Stashed")
  }, "Stash working tree changes.")

  editor.command("magit-stash-index", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const { out, err, code } = await git(stashPushArgs(args, ["--staged"]), root, undefined, undefined, editor)
    if (code !== 0) return editor.message(`git stash failed: ${err.trim()}`)
    await refresh(editor, root, 0)
    editor.message(out.trim() || "Stashed index")
  }, "Stash only staged/index changes.")

  editor.command("magit-stash-keep-index", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const { out, err, code } = await git(stashPushArgs(args, ["--keep-index"]), root, undefined, undefined, editor)
    if (code !== 0) return editor.message(`git stash failed: ${err.trim()}`)
    await refresh(editor, root, 0)
    editor.message(out.trim() || "Stashed while keeping index")
  }, "Stash working tree changes while keeping staged changes in the index.")

  editor.command("magit-stash-pop", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) {
      editor.message("Not in a Magit buffer")
      return
    }
    const stash = args[0] ?? await stashChoice(editor, root, buffer, "Pop stash: ")
    if (!stash) return editor.message("No stash")
    const { err, code } = await git(["stash", "pop", refname(stash)], root, undefined, undefined, editor)
    if (code !== 0) {
      editor.message(`git stash pop failed: ${err.trim()}`)
      return
    }
    await refresh(editor, root)
    editor.message(`Popped ${stash}`)
  }, "Pop a stash, defaulting to the stash at point.")

  editor.command("magit-discard", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    const hunk = hunkAtPoint(buffer)
    if (root && hunk) {
      const patch = partialPatchForRegion(buffer, hunk) ?? hunk.patch
      const partial = patch !== hunk.patch
      const ans = await editor.prompt(`Discard ${partial ? "selected lines" : "hunk"} in ${hunk.file}? (y or n) `)
      if (ans !== "y") {
        editor.message("Discard cancelled")
        return
      }
      const applyArgs = hunk.staged
        ? ["apply", "--index", "--reverse", "-"]
        : ["apply", "--reverse", "-"]
      const { err, code } = await git(applyArgs, root, patch, undefined, editor)
      if (code !== 0) {
        editor.message(`git apply failed: ${err.trim()}`)
        return
      }
      await refresh(editor, root)
      editor.message(`Discarded ${partial ? "selected lines" : "hunk"} in ${hunk.file}`)
      return
    }
    const entry = entryAtPoint(buffer)
    if (!root || !entry || (entry.staged && !entry.oldFile)) {
      editor.message("Nothing to discard at point")
      return
    }
    const ans = await editor.prompt(`Discard changes in ${fileDisplayName(entry)}? (y or n) `)
    if (ans !== "y") {
      editor.message("Discard cancelled")
      return
    }
    if (entry.staged && entry.oldFile) {
      const { err, code } = await git(["restore", "--staged", "--worktree", "--source=HEAD", "--", ...entryPathspecs(entry)], root, undefined, undefined, editor)
      if (code !== 0) {
        editor.message(`git restore failed: ${err.trim()}`)
        return
      }
    } else if (entry.oldFile) {
      const { err, code } = await git(["restore", "--worktree", "--source=HEAD", "--", ...entryPathspecs(entry)], root, undefined, undefined, editor)
      if (code !== 0) {
        editor.message(`git restore failed: ${err.trim()}`)
        return
      }
    } else if (entry.untracked) {
      // No HEAD/index version to restore — discarding an untracked file means removing it.
      try {
        await unlink(join(root, entry.file))
      } catch (e) {
        editor.message(`Discard failed: ${(e as Error).message}`)
        return
      }
    } else {
      const { err, code } = await git(["checkout", "--", entry.file], root, undefined, undefined, editor)
      if (code !== 0) {
        editor.message(`git checkout failed: ${err.trim()}`)
        return
      }
    }
    await refresh(editor, root)
    editor.message(`Discarded ${fileDisplayName(entry)}`)
  }, "Discard unstaged changes to the file at point (with confirmation).")

  editor.command("magit-file-untrack", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const entry = entryAtPoint(buffer)
    const file = args[0] ?? entry?.file
    if (!file) return editor.message("No file at point")
    const { err, code } = await git(["rm", "--cached", "--", String(file)], root, undefined, undefined, editor)
    if (code !== 0) return editor.message(`git rm --cached failed: ${err.trim() || code}`)
    await refresh(editor, root)
    editor.message(`Untracked ${file}`)
  }, "Stop tracking the file at point without deleting it from the worktree.")

  editor.command("magit-stage-intent-to-add", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const entry = entryAtPoint(buffer)
    let file = args[0] ? String(args[0]) : entry?.file
    if (!file) {
      const { out } = await git(["ls-files", "--others", "--exclude-standard"], root, undefined, undefined, editor)
      const files = out.split("\n").filter(Boolean)
      file = await editor.completingRead("Intent-to-add file: ", { collection: files, history: "magit-file" }) ?? undefined
    }
    if (!file) return
    const { err, code } = await git(["add", "-N", "--", file], root, undefined, undefined, editor)
    if (code !== 0) return editor.message(`git add -N failed: ${err.trim() || code}`)
    await refresh(editor, root)
    editor.message(`Marked ${file} intent-to-add`)
  }, "Add the file at point to the index with intent-to-add.")

  editor.command("magit-file-checkout", async ({ editor, buffer, args }) => {
    const path = buffer.path
    if (!path || buffer.kind === "directory") {
      editor.message("Buffer is not visiting a file")
      return
    }
    const root = await repositoryRootForFile(path)
    if (!root) return editor.message("Not in a git repository")
    const rev = args[0] ?? await editor.prompt("Checkout file from revision: ", "HEAD", "magit-file-checkout")
    if (!rev) return
    const file = await repoRelativePath(root, path)
    const { err, code } = await git(["checkout", refname(rev), "--", file], root, undefined, undefined, editor)
    if (code !== 0) return editor.message(`git checkout failed: ${err.trim() || code}`)
    await buffer.revert()
    editor.message(`Checked out ${file} from ${rev}`)
  }, "Checkout the current file from a revision and revert the buffer.")

  editor.command("magit-reset-quickly", async ({ editor, buffer, args, prefixArgument }) => {
    const root = magitRoot(buffer)
    if (!root) {
      editor.message("Not in a Magit buffer")
      return
    }
    const target = args[0] ?? refAtPoint(buffer)?.name ?? logShaAtPoint(buffer) ?? "HEAD"
    const mode = prefixArgument ? "--hard" : null
    const { err, code } = await git(["reset", ...(mode ? [mode] : []), refname(target), "--"], root, undefined, undefined, editor)
    if (code !== 0) {
      editor.message(`git reset failed: ${err.trim()}`)
      return
    }
    await refresh(editor, root, 0)
    editor.message(mode ? `Reset hard to ${target}` : `Reset index to ${target}`)
  }, "Quickly reset the index to a target, defaulting to HEAD.")

  editor.command("magit-reset", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const target = args[0] ?? refAtPoint(buffer)?.name ?? logShaAtPoint(buffer) ?? "HEAD"
    const { err, code } = await git(["reset", refname(target), "--"], root, undefined, undefined, editor)
    if (code !== 0) return editor.message(`git reset failed: ${err.trim()}`)
    await refresh(editor, root, 0)
    editor.message(`Reset index to ${target}`)
  }, "Reset the index to a target, defaulting to HEAD.")

  const resetHead = async (editor: Editor, buffer: BufferModel, mode: string, label: string, prompt: string, args: string[], confirm?: (target: string) => Promise<boolean>) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const target = await resetTarget(editor, root, buffer, prompt, args)
    if (!target) return
    if (confirm && !(await confirm(target))) return editor.message("Reset cancelled")
    const { err, code } = await git(["reset", mode, refname(target)], root, undefined, undefined, editor)
    if (code !== 0) {
      editor.message(`git reset failed: ${err.trim()}`)
      return
    }
    await refresh(editor, root, 0)
    editor.message(`${label} ${target}`)
  }

  editor.command("magit-reset-mixed", async ({ editor, buffer, args }) => {
    await resetHead(editor, buffer, "--mixed", "Reset mixed to", "Reset branch and index to: ", args)
  }, "Reset HEAD and index to a target.")

  editor.command("magit-reset-soft", async ({ editor, buffer, args }) => {
    await resetHead(editor, buffer, "--soft", "Reset soft to", "Soft reset branch to: ", args)
  }, "Reset HEAD to a target, keeping index and worktree.")

  editor.command("magit-reset-hard", async ({ editor, buffer, args }) => {
    await resetHead(editor, buffer, "--hard", "Reset hard to", "Hard reset branch to: ", args, async target => {
      const ans = await editor.prompt(`Hard reset to ${target}? (y or n) `)
      return ans === "y"
    })
  }, "Reset HEAD, index, and worktree to a target (with confirmation).")

  editor.command("magit-reset-keep", async ({ editor, buffer, args }) => {
    await resetHead(editor, buffer, "--keep", "Reset keep to", "Reset branch to, keeping local changes: ", args)
  }, "Reset HEAD and index to a target, keeping uncommitted changes.")

  editor.command("magit-reset-index", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const target = await resetTarget(editor, root, buffer, "Reset index to: ", args)
    if (!target) return
    const { err, code } = await git(["reset", refname(target), "--", "."], root, undefined, undefined, editor)
    if (code !== 0) return editor.message(`git reset failed: ${err.trim()}`)
    await refresh(editor, root, 0)
    editor.message(`Reset index to ${target}`)
  }, "Reset only the index to a target.")

  editor.command("magit-reset-worktree", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const target = await resetTarget(editor, root, buffer, "Reset worktree to: ", args)
    if (!target) return
    const indexPath = join(tmpdir(), `jemacs-magit-reset-index-${process.pid}-${Date.now()}`)
    const result = await git(["read-tree", refname(target)], root, undefined, { GIT_INDEX_FILE: indexPath }, editor)
    if (result.code !== 0) {
      await unlink(indexPath).catch(() => {})
      return editor.message(`git read-tree failed: ${result.err.trim()}`)
    }
    const checkout = await git(["checkout-index", "--all", "--force"], root, undefined, { GIT_INDEX_FILE: indexPath }, editor)
    await unlink(indexPath).catch(() => {})
    if (checkout.code !== 0) return editor.message(`git checkout-index failed: ${checkout.err.trim()}`)
    await refresh(editor, root, 0)
    editor.message(`Reset worktree to ${target}`)
  }, "Reset only the worktree to a target.")

  editor.command("magit-stage-modified", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const { err, code } = await git(["add", "-u"], root, undefined, undefined, editor)
    if (code !== 0) return editor.message(`git add failed: ${err.trim()}`)
    await refresh(editor, root)
    editor.message("Staged all modified tracked files")
  }, "Stage all changes to tracked files.")

  editor.command("magit-unstage-all", async ({ editor, buffer }) => {
    await editor.run("magit-reset-quickly")
  }, "Unstage all staged changes.")

  editor.command("magit-refresh-all", async ({ editor, buffer }) => {
    await editor.run("magit-refresh")
  }, "Refresh the current Magit buffer.")

  const remoteDefault = async (editor: Editor, root: string, kind: "push" | "upstream"): Promise<string> => {
    const { out: branch } = await git(["rev-parse", "--abbrev-ref", "HEAD"], root, undefined, undefined, editor)
    const b = branch.trim()
    if (kind === "push" && b) {
      const configured = await gitConfig(root, `branch.${b}.pushRemote`, editor)
        ?? await gitConfig(root, "remote.pushDefault", editor)
      if (configured) return configured
    }
    if (kind === "upstream") {
      const { out } = await git(["rev-parse", "--abbrev-ref", `${b}@{upstream}`], root, undefined, undefined, editor)
      const up = out.trim()
      if (up.includes("/")) return up.split("/")[0]!
    }
    const { out } = await git(["remote"], root, undefined, undefined, editor)
    return out.split("\n").find(Boolean) ?? "origin"
  }

  editor.command("magit-fetch-from-pushremote", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const remote = await remoteDefault(editor, root, "push")
    const { err, code } = await git(["fetch", refname(remote)], root, undefined, undefined, editor)
    if (code !== 0) return editor.message(`git fetch failed: ${err.trim()}`)
    await refresh(editor, root)
    editor.message(`Fetched from ${remote}`)
  }, "Fetch from push-remote.")

  editor.command("magit-fetch-from-upstream", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const remote = await remoteDefault(editor, root, "upstream")
    const { err, code } = await git(["fetch", refname(remote)], root, undefined, undefined, editor)
    if (code !== 0) return editor.message(`git fetch failed: ${err.trim()}`)
    await refresh(editor, root)
    editor.message(`Fetched from ${remote}`)
  }, "Fetch from upstream remote.")

  editor.command("magit-fetch-all", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const { err, code } = await git(["fetch", "--all"], root, undefined, undefined, editor)
    if (code !== 0) return editor.message(`git fetch failed: ${err.trim()}`)
    await refresh(editor, root)
    editor.message("Fetched all remotes")
  }, "Fetch from all remotes.")

  editor.command("magit-pull-from-upstream", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const remote = await remoteDefault(editor, root, "upstream")
    const { out } = await git(["rev-parse", "--abbrev-ref", "HEAD"], root, undefined, undefined, editor)
    const branch = out.trim()
    const { err, code } = await git(["pull", refname(remote), refname(branch)], root, undefined, undefined, editor)
    if (code !== 0) return editor.message(`git pull failed: ${err.trim()}`)
    await refresh(editor, root, 0)
    editor.message(`Pulled ${branch} from ${remote}`)
  }, "Pull from upstream.")

  editor.command("magit-pull-from-pushremote", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const remote = await remoteDefault(editor, root, "push")
    const { out } = await git(["rev-parse", "--abbrev-ref", "HEAD"], root, undefined, undefined, editor)
    const branch = out.trim()
    const { err, code } = await git(["pull", refname(remote), refname(branch)], root, undefined, undefined, editor)
    if (code !== 0) return editor.message(`git pull failed: ${err.trim()}`)
    await refresh(editor, root, 0)
    editor.message(`Pulled ${branch} from ${remote}`)
  }, "Pull from push-remote.")

  editor.command("magit-push-upstream", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const remote = await remoteDefault(editor, root, "upstream")
    const { out } = await git(["rev-parse", "--abbrev-ref", "HEAD"], root, undefined, undefined, editor)
    const branch = out.trim()
    const { err, code } = await git(["push", ...(args.includes("--set-upstream") ? ["--set-upstream"] : []), refname(remote), refname(branch)], root, undefined, undefined, editor)
    if (code !== 0) return editor.message(`git push failed: ${err.trim()}`)
    await refresh(editor, root)
    editor.message(`Pushed ${branch} to ${remote}`)
  }, "Push to upstream remote.")

  editor.command("magit-commit-amend", async ({ editor, buffer, args: commandArgs }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const signoff = commandArgs.includes("--signoff") ? ["--signoff"] : []
    const editBuffer = await startGitWithEditorFlow(editor, root, ["commit", "--amend", ...signoff], {
      successMessage: "Amended commit",
      failurePrefix: "git commit --amend failed",
      cancelledMessage: "Commit aborted",
      showCommitDiff: true,
      awaitOnFinish: true,
    })
    if (editBuffer) editor.message("Type C-c C-c to finish, C-c C-k to abort")
  }, "Amend the last commit.")

  editor.command("magit-stash-save", async ({ editor, buffer, args: commandArgs }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const msg = await editor.prompt("Stash message: ", "", "magit-stash")
    if (msg == null) return
    const args = stashPushArgs(commandArgs, msg.trim() ? ["-m", msg] : [])
    const { err, code } = await git(args, root, undefined, undefined, editor)
    if (code !== 0) return editor.message(`git stash failed: ${err.trim()}`)
    await refresh(editor, root, 0)
    editor.message("Saved stash")
  }, "Stash with optional message.")

  editor.command("magit-log-refresh", async ({ editor, buffer }) => {
    await editor.run("magit-log")
  }, "Refresh or open log buffer.")

  editor.command("magit-diff-visit-file", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Nothing to visit at point")
    const hunk = hunkAtPoint(buffer)
    const target = magitDiffVisitTarget(buffer.text, buffer.point, hunk?.file)
    if (!target) return editor.message("No diff line at point")
    const source = await editor.openFile(join(root, target.file))
    const [start] = source.lineBounds(Math.max(0, target.line - 1))
    source.point = start
  }, "Visit the source file and line for the diff hunk line at point.")

  editor.command("magit-visit-thing", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Nothing to visit at point")
    const hunk = hunkAtPoint(buffer)
    const target = magitDiffVisitTarget(buffer.text, buffer.point, hunk?.file)
    if (target) {
      const source = await editor.openFile(join(root, target.file))
      const [start] = source.lineBounds(Math.max(0, target.line - 1))
      source.point = start
      return
    }
    const entry = entryAtPoint(buffer)
    if (entry) {
      await editor.openFile(join(root, entry.file))
      return
    }
    const module = moduleAtPoint(buffer)
    if (module) {
      const modulePath = join(root, module.path)
      const moduleRoot = await git(["rev-parse", "--show-toplevel"], modulePath, undefined, undefined, editor)
      const target = moduleRoot.out.trim()
      if (moduleRoot.code !== 0 || !target) return editor.message(`Module is not initialized: ${module.path}`)
      await refresh(editor, target, 0)
      return
    }
    const worktree = worktreeAtPoint(buffer)
    if (worktree) {
      await refresh(editor, worktree.path, 0)
      return
    }
    const ref = refAtPoint(buffer)
    if (ref) {
      await visitRef(editor, root, ref, buffer)
      return
    }
    const stash = stashAtPoint(buffer)
    if (stash) {
      await editor.run("magit-stash-show", [stash])
      return
    }
    const rev = commitishAtPoint(buffer)
    if (rev) {
      if (buffer.mode === "magit-log") await editor.run("magit-log-show-commit")
      else await showRevision(editor, root, rev, buffer)
      return
    }
    editor.message("Nothing to visit at point")
  }, "Visit the file or commit at point.")

  editor.command("magit-dispatch", ({ editor }) => {
    editor.openTransient(magitDispatchTransient)
  }, "Show the Magit dispatch popup.")

  const jumpToSection = async (editor: Editor, buffer: BufferModel, title: string) => {
    const i = buffer.text.indexOf(title)
    if (i < 0) return editor.message(`Section not found: ${title}`)
    buffer.point = i
    editor.changed("magit-jump")
  }

  editor.command("magit-jump-to-staged", async ({ editor, buffer }) => {
    await jumpToSection(editor, buffer, "Staged changes")
  }, "Jump to staged changes section.")

  editor.command("magit-jump-to-unstaged", async ({ editor, buffer }) => {
    await jumpToSection(editor, buffer, "Unstaged changes")
  }, "Jump to unstaged changes section.")

  editor.command("magit-jump-to-stashes", async ({ editor, buffer }) => {
    await jumpToSection(editor, buffer, "Stashes")
  }, "Jump to stashes section.")

  editor.command("magit-init", async ({ editor, buffer, args }) => {
    const start = args[0] ?? buffer.directory() ?? process.cwd()
    const { err, code } = await git(["init"], start, undefined, undefined, editor)
    if (code !== 0) return editor.message(`git init failed: ${err.trim()}`)
    const root = await projectRoot(start)
    if (root) await refresh(editor, root)
    editor.message("Initialized git repository")
  }, "Initialize a git repository.")

  editor.command("magit-git-command", async ({ editor, buffer }) => {
    const root = magitRoot(buffer) ?? buffer.directory() ?? process.cwd()
    const cmd = await editor.prompt(`Async shell command in ${root}: `, "git ", "magit-git-command")
    if (!cmd?.trim()) return
    const proc = spawnProcess({
      cmd: ["sh", "-c", cmd],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err] = await Promise.all([
      proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
      proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
    ])
    const code = await proc.exited
    const buf = appendProcessEntry(editor, { args: [cmd], cwd: root, out, err, code, command: cmd })
    pushMagitHistory(buf, buffer)
    buf.point = 0
    editor.message(code === 0 ? "Command finished" : `Command failed (${code})`)
  }, "Run an arbitrary git/shell command.")

  editor.command("magit-process", ({ editor, buffer }) => {
    const root = magitRoot(buffer) ?? buffer.directory()
    const processBuffer = openProcessBuffer(editor, root)
    pushMagitHistory(processBuffer, buffer)
  }, "Show the Magit process buffer.")

  editor.command("magit-toggle-fold", async ({ editor, buffer }) => {
    await editor.run("magit-section-toggle")
  }, "Alias for magit-section-toggle.")

  editor.command("magit-mode-bury-buffer", async ({ editor }) => {
    await editor.run("previous-buffer")
  }, "Bury the current Magit buffer.")

  editor.command("magit-bury-buffer", async ({ editor }) => {
    await editor.run("magit-mode-bury-buffer")
  }, "Alias for magit-mode-bury-buffer.")

  const gitOutputMessage = (out: string, err: string, fallback: string): string => {
    return `${out}${err}`.trim() || fallback
  }

  const finishBisectStep = async (editor: Editor, buffer: BufferModel, root: string, out: string, err: string, fallback: string): Promise<void> => {
    const parsed = parseBisectOutput(`${out}\n${err}`)
    await refresh(editor, root)
    if (parsed?.kind === "culprit") {
      await showRevision(editor, root, parsed.sha, buffer)
      editor.message(parsed.line)
      return
    }
    editor.message(parsed?.line ?? gitOutputMessage(out, err, fallback))
  }

  editor.command("magit-bisect-start", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const bad = args[0] ?? await editor.prompt("Bisect bad revision: ", "HEAD", "magit-bisect-bad")
    if (!bad) return
    const good = args[1] ?? await editor.prompt("Bisect good revision: ", "", "magit-bisect-good")
    if (!good) return
    const { out, err, code } = await git(["bisect", "start", refname(bad), refname(good)], root, undefined, undefined, editor)
    if (code !== 0) return editor.message(`git bisect start failed: ${err.trim() || code}`)
    await refresh(editor, root, 0)
    editor.message(gitOutputMessage(out, err, `Bisect started: bad ${bad}, good ${good}`))
  }, "Start a git bisect session.")

  editor.command("magit-bisect-good", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const { out, err, code } = await git(["bisect", "good"], root, undefined, undefined, editor)
    if (code !== 0) return editor.message(`git bisect good failed: ${err.trim() || code}`)
    await finishBisectStep(editor, buffer, root, out, err, "Marked current revision good")
  }, "Mark the current bisect revision as good.")

  editor.command("magit-bisect-bad", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const { out, err, code } = await git(["bisect", "bad"], root, undefined, undefined, editor)
    if (code !== 0) return editor.message(`git bisect bad failed: ${err.trim() || code}`)
    await finishBisectStep(editor, buffer, root, out, err, "Marked current revision bad")
  }, "Mark the current bisect revision as bad.")

  editor.command("magit-bisect-skip", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const { out, err, code } = await git(["bisect", "skip"], root, undefined, undefined, editor)
    if (code !== 0) return editor.message(`git bisect skip failed: ${err.trim() || code}`)
    await finishBisectStep(editor, buffer, root, out, err, "Skipped current revision")
  }, "Skip the current bisect revision.")

  editor.command("magit-bisect-reset", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const { out, err, code } = await git(["bisect", "reset"], root, undefined, undefined, editor)
    if (code !== 0) return editor.message(`git bisect reset failed: ${err.trim() || code}`)
    await refresh(editor, root, 0)
    editor.message(gitOutputMessage(out, err, "Bisect reset"))
  }, "Reset the current git bisect session.")

  // --- Parity batch: merge, rebase, cherry-pick, revert, tag, remote, more ---

  /** Run a git command in the magit buffer's repo, then refresh + message. */
  const runGit = async (
    editor: Editor,
    buffer: BufferModel,
    args: string[],
    ok: string,
    opts: { resetPoint?: boolean; confirm?: string } = {},
  ): Promise<void> => {
    const root = magitRoot(buffer)
    if (!root) { editor.message("Not in a Magit buffer"); return }
    if (opts.confirm) {
      const ans = await editor.prompt(opts.confirm)
      if (ans !== "y") { editor.message("Cancelled"); return }
    }
    const { err, code } = await git(args, root, undefined, undefined, editor)
    if (code !== 0) { editor.message(`git ${args[0]} failed: ${err.trim()}`); return }
    await refresh(editor, root, opts.resetPoint ? 0 : undefined)
    editor.message(ok)
  }

  const branchList = async (editor: Editor, root: string, includeRemotes = false): Promise<string[]> => {
    const args = includeRemotes
      ? ["branch", "-a", "--format=%(refname:short)"]
      : ["branch", "--list", "--format=%(refname:short)"]
    const { out } = await git(args, root, undefined, undefined, editor)
    return out.split("\n").filter(Boolean)
  }

  const moduleChoice = async (editor: Editor, root: string, buffer: BufferModel, prompt: string): Promise<string | null> => {
    const atPoint = moduleAtPoint(buffer)?.path
    if (atPoint) return atPoint
    const modules = await listSubmodules(root, editor)
    if (!modules.length) return null
    if (modules.length === 1) return modules[0]!.path
    return editor.completingRead(prompt, { collection: modules.map(module => module.path), history: "magit-submodule" })
  }

  const worktreeChoice = async (editor: Editor, root: string, buffer: BufferModel, prompt: string, includeCurrent = false): Promise<MagitWorktree | null> => {
    const atPoint = worktreeAtPoint(buffer)
    if (atPoint && (includeCurrent || !atPoint.current)) return atPoint
    const worktrees = (await listWorktrees(root, editor)).filter(worktree => includeCurrent || !worktree.current)
    if (!worktrees.length) return null
    if (worktrees.length === 1) return worktrees[0]!
    const selected = await editor.completingRead(prompt, { collection: worktrees.map(worktree => worktreeLabel(worktree)), history: "magit-worktree" })
    if (!selected) return null
    return worktrees.find(worktree => selected.includes(worktree.path)) ?? null
  }

  editor.command("magit-submodule-add", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const url = args.find(arg => !arg.startsWith("--")) ?? await editor.prompt("Add submodule URL: ", "", "magit-submodule-url")
    if (!url) return
    const pathArg = args.find((arg, index) => index > args.indexOf(url) && !arg.startsWith("--"))
    const path = pathArg ?? await editor.prompt("Add submodule path: ", basename(url.replace(/\.git$/, "")), "magit-submodule-path")
    if (!path) return
    const flags = args.filter(arg => arg === "--force")
    await runGit(editor, buffer, ["submodule", "add", ...flags, url, path], `Added submodule ${path}`, { resetPoint: true })
  }, "Add a submodule.")

  editor.command("magit-submodule-init", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const module = args.find(arg => !arg.startsWith("--")) ?? await moduleChoice(editor, root, buffer, "Init submodule: ")
    if (!module) return editor.message("No submodule")
    await runGit(editor, buffer, ["submodule", "init", "--", module], `Initialized submodule ${module}`)
  }, "Initialize a submodule.")

  editor.command("magit-submodule-update", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const module = args.find(arg => !arg.startsWith("--")) ?? await moduleChoice(editor, root, buffer, "Update submodule: ")
    if (!module) return editor.message("No submodule")
    const flags = args.filter(arg => ["--force", "--recursive", "--no-fetch", "--remote"].includes(arg))
    await runGit(editor, buffer, ["submodule", "update", ...flags, "--", module], `Updated submodule ${module}`)
  }, "Update a submodule.")

  editor.command("magit-submodule-sync", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const module = args.find(arg => !arg.startsWith("--")) ?? await moduleChoice(editor, root, buffer, "Sync submodule: ")
    if (!module) return editor.message("No submodule")
    const flags = args.filter(arg => arg === "--recursive")
    await runGit(editor, buffer, ["submodule", "sync", ...flags, "--", module], `Synced submodule ${module}`)
  }, "Synchronize a submodule URL.")

  editor.command("magit-submodule-deinit", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const module = args.find(arg => !arg.startsWith("--")) ?? await moduleChoice(editor, root, buffer, "Deinit submodule: ")
    if (!module) return editor.message("No submodule")
    const ans = await editor.prompt(`Deinit submodule ${module}? (y or n) `)
    if (ans !== "y") return editor.message("Cancelled")
    await runGit(editor, buffer, ["submodule", "deinit", "-f", "--", module], `Deinitialized submodule ${module}`)
  }, "Deinitialize a submodule.")

  editor.command("magit-worktree-checkout", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const commitChoice = args[0] ?? await editor.completingRead("In new worktree; checkout: ", { collection: await branchOrCommitChoices(editor, root), history: "magit-worktree-commit", initialValue: "HEAD" })
    const commit = commitChoice?.trim().split(/\s+/, 1)[0]
    if (!commit) return
    const initialPath = join(root, "..", `${basename(root)}-${commit.replace(/[^A-Za-z0-9_.-]/g, "-")}`)
    const directory = args[1] ?? await editor.prompt(`Checkout ${commit} in new worktree: `, initialPath, "magit-worktree-directory")
    if (!directory) return
    const target = isAbsolute(directory) ? directory : join(root, directory)
    const { err, code } = await git(["worktree", "add", target, refname(commit)], root, undefined, undefined, editor)
    if (code !== 0) return editor.message(`git worktree failed: ${err.trim()}`)
    await refresh(editor, target, 0)
    editor.message(`Created worktree ${target}`)
  }, "Checkout a commit or branch in a new worktree.")

  editor.command("magit-worktree-branch", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const branch = args[0] ?? await editor.prompt("New worktree branch: ", "", "magit-worktree-branch")
    if (!branch) return
    const startChoice = args[1] ?? await editor.completingRead("Start point: ", { collection: await branchOrCommitChoices(editor, root), history: "magit-worktree-start", initialValue: "HEAD" })
    const startPoint = startChoice?.trim().split(/\s+/, 1)[0]
    if (!startPoint) return
    const initialPath = join(root, "..", `${basename(root)}-${branch.replace(/[^A-Za-z0-9_.-]/g, "-")}`)
    const directory = args[2] ?? await editor.prompt(`Checkout ${branch} in new worktree: `, initialPath, "magit-worktree-directory")
    if (!directory) return
    const target = isAbsolute(directory) ? directory : join(root, directory)
    const { err, code } = await git(["worktree", "add", "-b", refname(branch), target, refname(startPoint)], root, undefined, undefined, editor)
    if (code !== 0) return editor.message(`git worktree failed: ${err.trim()}`)
    await refresh(editor, target, 0)
    editor.message(`Created worktree ${target}`)
  }, "Create a branch and checkout it in a new worktree.")

  editor.command("magit-worktree-status", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const selected = args[0]
      ? (await listWorktrees(root, editor)).find(worktree => worktree.path === args[0])
      : await worktreeChoice(editor, root, buffer, "Visit worktree: ", true)
    if (!selected) return editor.message("No worktree")
    await refresh(editor, selected.path, 0)
  }, "Visit a worktree's Magit status buffer.")

  editor.command("magit-worktree-delete", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const selected = args[0]
      ? (await listWorktrees(root, editor)).find(worktree => worktree.path === args[0])
      : await worktreeChoice(editor, root, buffer, "Delete worktree: ")
    if (!selected) return editor.message("No worktree")
    const ans = await editor.prompt(`Delete worktree ${selected.path}? (y or n) `)
    if (ans !== "y") return editor.message("Cancelled")
    const { err, code } = await git(["worktree", "remove", selected.path], root, undefined, undefined, editor)
    if (code !== 0) return editor.message(`git worktree failed: ${err.trim()}`)
    await refresh(editor, root, 0)
    editor.message(`Deleted worktree ${selected.path}`)
  }, "Delete a linked worktree.")

  editor.command("magit-merge", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const branch = args[0] ?? await editor.completingRead("Merge branch: ", { collection: await branchList(editor, root, true), history: "magit-merge" })
    if (!branch) return
    const editBuffer = await startGitWithEditorFlow(editor, root, ["merge", "--edit", refname(branch)], {
      successMessage: `Merged ${branch}`,
      failurePrefix: "git merge failed",
      cancelledMessage: "Merge aborted",
      awaitOnFinish: true,
    })
    if (editBuffer) editor.message("Type C-c C-c to finish, C-c C-k to abort")
  }, "Merge another branch into the current branch.")

  editor.command("magit-merge-abort", async ({ editor, buffer }) => {
    await runGit(editor, buffer, ["merge", "--abort"], "Merge aborted", { resetPoint: true })
  }, "Abort an in-progress merge.")

  editor.command("magit-rebase", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const onto = args[0] ?? await editor.completingRead("Rebase onto: ", { collection: await branchList(editor, root, true), history: "magit-rebase" })
    if (!onto) return
    await runGit(editor, buffer, ["rebase", refname(onto)], `Rebased onto ${onto}`, { resetPoint: true })
  }, "Rebase the current branch onto another branch.")

  editor.command("magit-rebase-interactive", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const base = args[0] ?? await editor.prompt("Interactively rebase from: ", "HEAD~5", "magit-rebase-interactive")
    if (!base) return
    const editBuffer = await startGitWithEditorFlow(editor, root, magitRebaseInteractiveArgs(base), {
      successMessage: "Interactive rebase finished",
      failurePrefix: "git rebase failed",
      cancelledMessage: "Interactive rebase aborted",
      awaitOnFinish: false,
    })
    if (editBuffer) editor.message("Edit rebase todo, then C-c C-c to start; C-c C-k aborts")
  }, "Start an interactive rebase using an editable git-rebase todo buffer.")

  editor.command("magit-rebase-continue", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const editBuffer = await startGitWithEditorFlow(editor, root, ["rebase", "--continue"], {
      successMessage: "Rebase continued",
      failurePrefix: "git rebase failed",
      cancelledMessage: "Rebase aborted",
      awaitOnFinish: false,
    })
    if (editBuffer) editor.message("Type C-c C-c to finish, C-c C-k to abort")
  }, "Continue an in-progress rebase.")

  editor.command("magit-rebase-skip", async ({ editor, buffer }) => {
    await runGit(editor, buffer, ["rebase", "--skip"], "Skipped commit", { resetPoint: true })
  }, "Skip the current commit during a rebase.")

  editor.command("magit-rebase-abort", async ({ editor, buffer }) => {
    await runGit(editor, buffer, ["rebase", "--abort"], "Rebase aborted", { resetPoint: true })
  }, "Abort an in-progress rebase.")

  const changeRebaseTodoAction = (buffer: BufferModel, action: RebaseTodoAction): void => {
    const next = changeTodoActionAtPoint(buffer.text, buffer.point, action)
    buffer.replaceRange(0, buffer.text.length, next.text)
    buffer.point = next.point
  }

  editor.command("git-rebase-pick", ({ editor, buffer }) => {
    if (buffer.mode !== "git-rebase-mode") return editor.message("Not in a git-rebase todo buffer")
    changeRebaseTodoAction(buffer, "pick")
  }, "Change the current rebase todo line to pick.")

  editor.command("git-rebase-reword", ({ editor, buffer }) => {
    if (buffer.mode !== "git-rebase-mode") return editor.message("Not in a git-rebase todo buffer")
    changeRebaseTodoAction(buffer, "reword")
  }, "Change the current rebase todo line to reword.")

  editor.command("git-rebase-edit", ({ editor, buffer }) => {
    if (buffer.mode !== "git-rebase-mode") return editor.message("Not in a git-rebase todo buffer")
    changeRebaseTodoAction(buffer, "edit")
  }, "Change the current rebase todo line to edit.")

  editor.command("git-rebase-squash", ({ editor, buffer }) => {
    if (buffer.mode !== "git-rebase-mode") return editor.message("Not in a git-rebase todo buffer")
    changeRebaseTodoAction(buffer, "squash")
  }, "Change the current rebase todo line to squash.")

  editor.command("git-rebase-fixup", ({ editor, buffer }) => {
    if (buffer.mode !== "git-rebase-mode") return editor.message("Not in a git-rebase todo buffer")
    changeRebaseTodoAction(buffer, "fixup")
  }, "Change the current rebase todo line to fixup.")

  editor.command("git-rebase-drop", ({ editor, buffer }) => {
    if (buffer.mode !== "git-rebase-mode") return editor.message("Not in a git-rebase todo buffer")
    changeRebaseTodoAction(buffer, "drop")
  }, "Change the current rebase todo line to drop.")

  const moveRebaseTodoLine = (buffer: BufferModel, direction: 1 | -1): void => {
    const next = moveTodoLine(buffer.text, buffer.point, direction)
    buffer.replaceRange(0, buffer.text.length, next.text)
    buffer.point = next.point
  }

  editor.command("git-rebase-move-line-up", ({ editor, buffer }) => {
    if (buffer.mode !== "git-rebase-mode") return editor.message("Not in a git-rebase todo buffer")
    moveRebaseTodoLine(buffer, -1)
  }, "Move the current rebase todo line up.")

  editor.command("git-rebase-move-line-down", ({ editor, buffer }) => {
    if (buffer.mode !== "git-rebase-mode") return editor.message("Not in a git-rebase todo buffer")
    moveRebaseTodoLine(buffer, 1)
  }, "Move the current rebase todo line down.")

  editor.command("git-rebase-finish", async ({ editor, buffer }) => {
    if (await finishWithEditorBuffer(editor, buffer)) return
    const root = magitRoot(buffer)
    const base = buffer.locals.get("magit-rebase-base") as string | undefined
    if (!root || !base || buffer.mode !== "git-rebase-mode") return editor.message("Not in a git-rebase todo buffer")
    const todoText = buffer.text
    const todoPath = join(tmpdir(), `jemacs-git-rebase-todo-${process.pid}-${Date.now()}`)
    const result = await runInteractiveRebaseTodo({
      base,
      cwd: root,
      todoText,
      todoPath,
      writeTodoFile: writeFile,
      runner: (args, cwd, env) => git(args, cwd, undefined, env),
    }).finally(() => unlink(todoPath).catch(() => {}))
    const winconf = buffer.locals.get("magit-winconf") as ReturnType<Editor["currentWindowConfiguration"]> | undefined
    editor.killBuffer(buffer.id)
    if (winconf) editor.restoreWindowConfiguration(winconf)
    await refresh(editor, root, 0)
    appendProcessEntry(editor, { args: result.args, cwd: root, out: result.out, err: result.err, code: result.code })
    const hasReword = /^\s*reword\s+/m.test(todoText)
    const suffix = hasReword ? "; reword keeps the original message unless the rebase stops" : ""
    editor.message(result.code === 0 ? `Interactive rebase started${suffix}` : `git rebase failed: ${result.err.trim() || result.code}${suffix}`)
  }, "Finish the git-rebase todo buffer and run git rebase -i.")

  editor.command("git-rebase-abort", async ({ editor, buffer }) => {
    if (isWithEditorBuffer(buffer)) {
      await abortWithEditorEdit(editor, buffer, "Interactive rebase aborted")
      return
    }
    if (buffer.mode !== "git-rebase-mode") return editor.message("Not in a git-rebase todo buffer")
    const winconf = buffer.locals.get("magit-winconf") as ReturnType<Editor["currentWindowConfiguration"]> | undefined
    editor.killBuffer(buffer.id)
    if (winconf) editor.restoreWindowConfiguration(winconf)
    editor.message("Interactive rebase aborted")
  }, "Abort editing the git-rebase todo buffer.")

  editor.command("magit-cherry-pick", async ({ editor, buffer, args }) => {
    const sha = args[0] ?? logShaAtPoint(buffer)
    if (!sha) return editor.message("No commit at point")
    await runGit(editor, buffer, ["cherry-pick", refname(sha)], `Cherry-picked ${sha}`, { resetPoint: true })
  }, "Cherry-pick the commit at point.")

  editor.command("magit-cherry-pick-skip", async ({ editor, buffer }) => {
    await runGit(editor, buffer, ["cherry-pick", "--skip"], "Skipped commit", { resetPoint: true })
  }, "Skip the current commit during a cherry-pick.")

  editor.command("magit-cherry-pick-abort", async ({ editor, buffer }) => {
    await runGit(editor, buffer, ["cherry-pick", "--abort"], "Cherry-pick aborted", { resetPoint: true })
  }, "Abort an in-progress cherry-pick.")

  editor.command("magit-revert", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const sha = args[0] ?? logShaAtPoint(buffer)
    if (!sha) return editor.message("No commit at point")
    const editBuffer = await startGitWithEditorFlow(editor, root, ["revert", "--edit", refname(sha)], {
      successMessage: `Reverted ${sha}`,
      failurePrefix: "git revert failed",
      cancelledMessage: "Revert aborted",
      awaitOnFinish: true,
    })
    if (editBuffer) editor.message("Type C-c C-c to finish, C-c C-k to abort")
  }, "Revert the commit at point.")

  editor.command("magit-revert-abort", async ({ editor, buffer }) => {
    await runGit(editor, buffer, ["revert", "--abort"], "Revert aborted", { resetPoint: true })
  }, "Abort an in-progress revert.")

  editor.command("magit-tag", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const name = args[0] ?? await editor.prompt("Tag name: ", "", "magit-tag")
    if (!name) return
    const rev = args[1] ?? logShaAtPoint(buffer) ?? "HEAD"
    const editBuffer = await startGitWithEditorFlow(editor, root, ["tag", "-a", refname(name), refname(rev)], {
      successMessage: `Tagged ${name}`,
      failurePrefix: "git tag failed",
      cancelledMessage: "Tag cancelled",
      awaitOnFinish: true,
    })
    if (editBuffer) editor.message("Type C-c C-c to finish, C-c C-k to abort")
  }, "Create a tag at the commit at point (or HEAD).")

  editor.command("magit-tag-delete", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const { out } = await git(["tag", "--list"], root, undefined, undefined, editor)
    const name = args[0] ?? await editor.completingRead("Delete tag: ", { collection: out.split("\n").filter(Boolean), history: "magit-tag" })
    if (!name) return
    await runGit(editor, buffer, ["tag", "-d", refname(name)], `Deleted tag ${name}`)
  }, "Delete a tag.")

  editor.command("magit-remote-add", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const name = args[0] ?? await editor.prompt("Remote name: ", "origin", "magit-remote")
    if (!name) return
    const url = args[1] ?? await editor.prompt(`URL for ${name}: `, "", "magit-remote-url")
    if (!url) return
    await runGit(editor, buffer, ["remote", "add", refname(name), url], `Added remote ${name}`)
  }, "Add a remote.")

  editor.command("magit-remote-remove", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const { out } = await git(["remote"], root, undefined, undefined, editor)
    const name = args[0] ?? await editor.completingRead("Remove remote: ", { collection: out.split("\n").filter(Boolean), history: "magit-remote" })
    if (!name) return
    await runGit(editor, buffer, ["remote", "remove", refname(name)], `Removed remote ${name}`)
  }, "Remove a remote.")

  editor.command("magit-remote-rename", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const { out } = await git(["remote"], root, undefined, undefined, editor)
    const old = args[0] ?? await editor.completingRead("Rename remote: ", { collection: out.split("\n").filter(Boolean), history: "magit-remote" })
    if (!old) return
    const next = args[1] ?? await editor.prompt(`Rename ${old} to: `, "", "magit-remote")
    if (!next) return
    await runGit(editor, buffer, ["remote", "rename", refname(old), refname(next)], `Renamed ${old} to ${next}`)
  }, "Rename a remote.")

  editor.command("magit-branch-delete", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const ref = refAtPoint(buffer)
    const branch = args[0] ?? (ref?.kind === "local" || ref?.kind === "remote" ? ref.name : null)
      ?? await editor.completingRead("Delete branch: ", { collection: await branchList(editor, root, true), history: "magit-branch" })
    if (!branch) return
    const remote = branch.includes("/") && ref?.kind === "remote"
    const deleteArgs = ["branch", ...(remote ? ["-r"] : []), "-d", refname(branch)]
    const first = await git(deleteArgs, root, undefined, undefined, editor)
    if (first.code === 0) {
      await (buffer.mode === "magit-refs-mode" ? openRefs(editor, root, undefined, buffer.point) : refresh(editor, root))
      editor.message(`Deleted branch ${branch}`)
      return
    }
    if (remote || !/not fully merged|not fully merged|not merged|not been merged/i.test(first.err)) {
      return editor.message(`git branch failed: ${first.err.trim() || first.code}`)
    }
    const ans = await editor.prompt(`Branch ${branch} is unmerged; delete with -D? (y or n) `)
    if (ans !== "y") return editor.message("Cancelled")
    const forced = await git(["branch", "-D", refname(branch)], root, undefined, undefined, editor)
    if (forced.code !== 0) return editor.message(`git branch failed: ${forced.err.trim() || forced.code}`)
    await (buffer.mode === "magit-refs-mode" ? openRefs(editor, root, undefined, buffer.point) : refresh(editor, root))
    editor.message(`Deleted branch ${branch}`)
  }, "Delete a branch.")

  editor.command("magit-branch-rename", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const old = args[0] ?? await editor.completingRead("Rename branch: ", { collection: await branchList(editor, root), history: "magit-branch" })
    if (!old) return
    const next = args[1] ?? await editor.prompt(`Rename ${old} to: `, "", "magit-branch")
    if (!next) return
    await runGit(editor, buffer, ["branch", "-m", refname(old), refname(next)], `Renamed ${old} to ${next}`, { resetPoint: true })
  }, "Rename a branch.")

  editor.command("magit-stash-apply", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const stash = args[0] ?? await stashChoice(editor, root, buffer, "Apply stash: ")
    if (!stash) return editor.message("No stash")
    const { err, code } = await git(["stash", "apply", refname(stash)], root, undefined, undefined, editor)
    if (code !== 0) return editor.message(`git stash apply failed: ${err.trim()}`)
    await refresh(editor, root)
    editor.message(`Applied ${stash}`)
  }, "Apply a stash without dropping it.")

  editor.command("magit-stash-drop", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const stash = args[0] ?? await stashChoice(editor, root, buffer, "Drop stash: ")
    if (!stash) return editor.message("No stash")
    const ans = await editor.prompt(`Drop ${stash}? (y or n) `)
    if (ans !== "y") return editor.message("Cancelled")
    const { err, code } = await git(["stash", "drop", refname(stash)], root, undefined, undefined, editor)
    if (code !== 0) return editor.message(`git stash drop failed: ${err.trim()}`)
    await refresh(editor, root)
    editor.message(`Dropped ${stash}`)
  }, "Drop a stash (with confirmation).")

  editor.command("magit-stash-list", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const { out } = await git(["stash", "list"], root, undefined, undefined, editor)
    const buf = editor.scratch("*magit-stash-list*", out || "(no stashes)\n", "magit-revision-mode")
    buf.readOnly = true
    buf.locals.set("magit-root", root)
    pushMagitHistory(buf, buffer)
    buf.point = 0
  }, "List stashes in a buffer.")

  editor.command("magit-stash-show", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const stash = args[0] ?? await stashChoice(editor, root, buffer, "Show stash: ")
    if (!stash) return editor.message("No stash")
    const { out, err, code } = await git(["stash", "show", "--stat", "-p", refname(stash)], root, undefined, undefined, editor)
    if (code !== 0) return editor.message(`git stash show failed: ${err.trim()}`)
    const buf = editor.scratch(`*magit-stash: ${stash}*`, out || "(empty stash)\n", "magit-diff-mode")
    buf.readOnly = true
    buf.locals.set("magit-root", root)
    buf.locals.set("magit-diff-title", stash)
    pushMagitHistory(buf, buffer)
    buf.point = 0
  }, "Show a stash as a diff buffer.")

  editor.command("magit-stash-branch", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const stash = args[1] ?? await stashChoice(editor, root, buffer, "Branch from stash: ")
    if (!stash) return editor.message("No stash")
    const branch = args[0] ?? await editor.prompt("Stash branch name: ", "", "magit-stash-branch")
    if (!branch) return
    const { err, code } = await git(["stash", "branch", refname(branch), refname(stash)], root, undefined, undefined, editor)
    if (code !== 0) return editor.message(`git stash branch failed: ${err.trim()}`)
    await refresh(editor, root, 0)
    editor.message(`Created branch ${branch} from ${stash}`)
  }, "Create and checkout a branch from a stash.")

  editor.command("magit-commit-extend", async ({ editor, buffer }) => {
    await runGit(editor, buffer, ["commit", "--amend", "--no-edit"], "Extended commit", { resetPoint: true })
  }, "Add staged changes to HEAD without editing the message.")

  editor.command("magit-commit-reword", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const editBuffer = await startGitWithEditorFlow(editor, root, magitCommitRewordArgs(), {
      successMessage: "Reworded commit",
      failurePrefix: "git commit --amend failed",
      cancelledMessage: "Reword cancelled",
      showCommitDiff: false,
      awaitOnFinish: true,
    })
    if (editBuffer) editor.message("Type C-c C-c to finish, C-c C-k to abort")
  }, "Edit the message of HEAD without changing its tree.")

  editor.command("magit-commit-fixup", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const target = await recentCommitChoice(editor, root, "Fixup commit: ")
    if (!target) return
    await runGit(editor, buffer, magitCommitFixupArgs(target), `Created fixup for ${target}`, { resetPoint: true })
  }, "Create a fixup commit for a recent commit.")

  editor.command("magit-commit-squash", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const target = await recentCommitChoice(editor, root, "Squash commit: ")
    if (!target) return
    const editBuffer = await startGitWithEditorFlow(editor, root, magitCommitSquashArgs(target), {
      successMessage: `Created squash for ${target}`,
      failurePrefix: "git commit --squash failed",
      cancelledMessage: "Squash cancelled",
      showCommitDiff: true,
      awaitOnFinish: true,
    })
    if (editBuffer) editor.message("Type C-c C-c to finish, C-c C-k to abort")
  }, "Create a squash commit for a recent commit.")

  const openDiff = async (
    editor: Editor,
    buffer: BufferModel,
    kind: "working-tree" | "unstaged" | "staged" | "range",
    commandArgs: readonly string[],
    explicitRange?: string | null,
  ) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const built = diffCommandArgs(kind, commandArgs, buffer, magitDiffContext(buffer), explicitRange)
    if (!built) return editor.message("No diff range")
    const { gitArgs, context, title } = built
    const { out } = await git(withDiffOptions(gitArgs, displayDiffContextArgs(gitArgs, context)), root, undefined, undefined, editor)
    const buf = editor.scratch(`*magit-diff: ${title}*`, out || "(no changes)\n", "magit-diff-mode")
    buf.readOnly = true
    buf.locals.set("magit-root", root)
    buf.locals.set("magit-diff-args", gitArgs)
    buf.locals.set("magit-diff-title", title)
    buf.locals.set("magit-diff-context", context)
    pushMagitHistory(buf, buffer)
    buf.point = 0
  }

  editor.command("magit-diff-working-tree", async ({ editor, buffer, args }) => {
    await openDiff(editor, buffer, "working-tree", args)
  }, "Show the diff of the working tree against HEAD.")

  editor.command("magit-diff-working", async ({ editor, buffer, args }) => {
    await editor.run("magit-diff-working-tree", args)
  }, "Alias for magit-diff-working-tree.")

  editor.command("magit-diff-unstaged", async ({ editor, buffer, args }) => {
    await openDiff(editor, buffer, "unstaged", args)
  }, "Show unstaged changes.")

  editor.command("magit-diff-staged", async ({ editor, buffer, args }) => {
    await openDiff(editor, buffer, "staged", args)
  }, "Show staged changes.")

  editor.command("magit-diff-range", async ({ editor, buffer, args }) => {
    const parsed = parseMagitDiffArgs(args)
    const explicit = parsed.range ?? parsed.positionals[0] ?? await editor.prompt("Diff range: ", "HEAD", "magit-diff-range")
    if (!explicit) return
    await openDiff(editor, buffer, "range", args, explicit)
  }, "Show a diff for an arbitrary revision range.")

  editor.key("C-x g", "magit-status")
  editor.key("C-c g", "magit-dispatch")
}
