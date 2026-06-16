import { unlink, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { basename, isAbsolute, join } from "node:path"
import type { Editor, TransientDefinition } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { BufferModel } from "../../src/kernel/buffer"
import { defineMode, modeLineage, type FontLockRange, type TextSpan } from "../../src/modes/mode"
import { Keymap } from "../../src/kernel/keymap"
import { nextWindowId } from "../../src/kernel/window"
import { spawnProcess } from "../../src/platform/runtime"
import { diffFontLockText } from "../../src/modes/diff"
import { projectRoot } from "../project"

/** A file-level section in the status buffer; line ranges let s/u act on the diff body too. */
export type MagitEntry = {
  file: string
  staged: boolean
  untracked: boolean
  startLine: number
  endLine: number
}

/** One @@-hunk's range in the status buffer plus a self-contained patch for `git apply --cached`. */
export type MagitHunk = {
  file: string
  staged: boolean
  startLine: number
  endLine: number
  patch: string
}

type MagitHistoryMark = { bufferId: string; point: number }

/** Reject names that would be parsed as a flag by git. */
function refname(s: string): string {
  if (s.startsWith("-")) throw new Error(`invalid ref/remote name: ${s}`)
  return s
}

async function git(args: string[], cwd: string, stdin?: string): Promise<{ out: string; err: string; code: number | null }> {
  const proc = spawnProcess({
    cmd: ["git", ...args],
    cwd,
    stdin: stdin != null ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  if (stdin != null && proc.stdin) {
    proc.stdin.write(stdin)
    proc.stdin.end()
  }
  const [out, err] = await Promise.all([
    proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
    proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
  ])
  const code = await proc.exited
  return { out, err, code }
}

type FileChange = { file: string; xy: string }

/** Minimal porcelain=v2 reader: just the XY state and path of ordinary/renamed/untracked entries. */
export function parsePorcelain(out: string): { branch: string | null; upstream: string | null; files: FileChange[] } {
  let branch: string | null = null
  let upstream: string | null = null
  const files: FileChange[] = []
  for (const line of out.split("\n")) {
    if (!line) continue
    if (line.startsWith("# branch.head ")) branch = line.slice("# branch.head ".length)
    else if (line.startsWith("# branch.upstream ")) upstream = line.slice("# branch.upstream ".length)
    else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const parts = line.split(" ")
      const xy = parts[1] ?? ".."
      const file = line.startsWith("2 ")
        ? (parts.slice(9).join(" ").split("\t")[0] ?? "")
        : parts.slice(8).join(" ")
      if (file) files.push({ file, xy })
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
    case "R": return "renamed   "
    case "?": return "untracked "
    default: return "modified  "
  }
}

export type DiffHunk = { header: string; lines: string[] }
export type FileDiff = { file: string; header: string[]; hunks: DiffHunk[] }

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

export type MagitStatus = {
  root: string
  text: string
  entries: MagitEntry[]
  hunks: MagitHunk[]
}

const DEFAULT_DIFF_CONTEXT = 3

function foldKey(file: string, staged: boolean): string {
  return `${staged ? "S" : "U"}:${file}`
}

export async function buildStatus(root: string, folded: ReadonlySet<string> = new Set(), context = DEFAULT_DIFF_CONTEXT): Promise<MagitStatus> {
  const diffContextArgs = magitDiffContextArgs(context)
  const [status, headMsg, unstagedDiff, stagedDiff, log, stashList] = await Promise.all([
    git(["status", "--porcelain=v2", "--branch"], root),
    git(["log", "-1", "--pretty=%s"], root),
    git(["diff", ...diffContextArgs], root),
    git(["diff", "--cached", ...diffContextArgs], root),
    git(["log", "-n", "10", "--pretty=%h %s"], root),
    git(["stash", "list"], root),
  ])
  const { branch, upstream, files } = parsePorcelain(status.out)
  const unstagedDiffs = new Map(parseDiff(unstagedDiff.out).map(d => [d.file, d]))
  const stagedDiffs = new Map(parseDiff(stagedDiff.out).map(d => [d.file, d]))

  const unstaged = files.filter(f => f.xy[1] !== "." && f.xy[1] !== undefined)
  const staged = files.filter(f => f.xy[0] !== "." && f.xy[0] !== "?")

  const lines: string[] = []
  const entries: MagitEntry[] = []
  const hunks: MagitHunk[] = []
  const push = (s: string) => lines.push(s)

  push(`Head:     ${branch ?? "(detached)"} ${headMsg.out.trim()}`)
  if (upstream) push(`Merge:    ${upstream}`)
  push("")

  const section = (title: string, items: FileChange[], isStaged: boolean, diffs: Map<string, FileDiff>) => {
    if (!items.length) return
    push(`${title} (${items.length})`)
    for (const f of items) {
      const code = isStaged ? f.xy[0]! : f.xy[1]!
      const start = lines.length
      push(`${changeLabel(code)} ${f.file}`)
      const fd = diffs.get(f.file)
      if (!folded.has(foldKey(f.file, isStaged))) {
        for (const h of fd?.hunks ?? []) {
          const hStart = lines.length
          push(h.header)
          for (const l of h.lines) push(l)
          hunks.push({
            file: f.file,
            staged: isStaged,
            startLine: hStart,
            endLine: lines.length - 1,
            patch: hunkPatch(fd!, h),
          })
        }
      }
      entries.push({ file: f.file, staged: isStaged, untracked: code === "?", startLine: start, endLine: lines.length - 1 })
    }
    push("")
  }
  section("Unstaged changes", unstaged, false, unstagedDiffs)
  section("Staged changes", staged, true, stagedDiffs)

  const stashes = stashList.out.split("\n").filter(Boolean)
  if (stashes.length) {
    push(`Stashes (${stashes.length})`)
    for (const s of stashes) push(s)
    push("")
  }

  const commits = log.out.split("\n").filter(Boolean)
  if (commits.length) {
    push("Recent commits")
    for (const c of commits) push(c)
    push("")
  }

  return { root, text: lines.join("\n"), entries, hunks }
}

function lineAt(buffer: BufferModel): number {
  return buffer.text.slice(0, buffer.point).split("\n").length - 1
}

export function entryAtPoint(buffer: BufferModel): MagitEntry | null {
  const entries = buffer.locals.get("magit-entries") as MagitEntry[] | undefined
  if (!entries) return null
  const line = lineAt(buffer)
  return entries.find(e => line >= e.startLine && line <= e.endLine) ?? null
}

export function hunkAtPoint(buffer: BufferModel): MagitHunk | null {
  const hunks = buffer.locals.get("magit-hunks") as MagitHunk[] | undefined
  if (!hunks) return null
  const line = lineAt(buffer)
  return hunks.find(h => line >= h.startLine && line <= h.endLine) ?? null
}

async function refresh(editor: Editor, root: string, point?: number): Promise<BufferModel> {
  const name = `*magit: ${basename(root)}*`
  const prev = [...editor.buffers.values()].find(b => b.name === name)
  const folded = (prev?.locals.get("magit-folded") as Set<string> | undefined) ?? new Set<string>()
  const context = magitDiffContext(prev)
  const status = await buildStatus(root, folded, context)
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
  buf.locals.set("magit-folded", folded)
  buf.locals.set("magit-diff-context", context)
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

function magitDiffBaseArgs(buffer: BufferModel): string[] | null {
  const args = buffer.locals.get("magit-diff-args") as string[] | undefined
  return args ? [...args] : null
}

function modeDerivesFrom(mode: string, parent: string): boolean {
  return modeLineage(mode).some(entry => entry.name === parent)
}

async function refreshDiffBuffer(editor: Editor, buffer: BufferModel, context: number): Promise<boolean> {
  const root = magitRoot(buffer)
  if (!root) return false
  if (buffer.mode === "magit-status") {
    const folded = (buffer.locals.get("magit-folded") as Set<string> | undefined) ?? new Set<string>()
    const point = buffer.point
    const status = await buildStatus(root, folded, context)
    buffer.setText(status.text, false)
    buffer.locals.set("magit-entries", status.entries)
    buffer.locals.set("magit-hunks", status.hunks)
    buffer.locals.set("magit-diff-context", context)
    buffer.point = Math.min(point, buffer.text.length)
    editor.message(`Diff context is ${context}`)
    return true
  }
  const baseArgs = magitDiffBaseArgs(buffer)
  const title = buffer.locals.get("magit-diff-title") as string | undefined
  if (!baseArgs || !title) return false
  const { out } = await git([...baseArgs, ...magitDiffContextArgs(context)], root)
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
  const { out: diff } = await git(["diff", "--cached", ...magitDiffContextArgs(context)], root)
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
    if (/^(Head|Merge|Unstaged|Staged|Stashes|Recent)\b/.test(line)) sectionSpans.push({ start: offset, end, face: "keyword" })
    offset = end + 1
  }
  return [...sectionSpans, ...diffFontLockText(text, base)]
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

async function openLog(editor: Editor, root: string, source?: BufferModel): Promise<BufferModel> {
  const { out } = await git(["log", "--oneline", "--graph", "-50"], root)
  const buf = editor.scratch("*magit-log*", out || "(no commits)\n", "magit-log")
  buf.readOnly = true
  buf.path = root
  buf.locals.set("magit-root", root)
  if (source) pushMagitHistory(buf, source)
  buf.point = 0
  return buf
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
      { key: "- n", label: "limit", argument: "--max-count", kind: "value", defaultValue: "" },
    ] },
    { title: "Actions", suffixes: [
      { key: "l", label: "log current", command: "magit-log" },
    ] },
  ],
}

const magitDiffTransient: TransientDefinition = {
  name: "magit-diff",
  title: "Diff",
  groups: [
    { title: "Arguments", infixes: [
      { key: "r", label: "range", argument: "--range", kind: "value", defaultValue: "" },
    ] },
    { title: "Actions", suffixes: [
      { key: "d", label: "working tree", command: "magit-diff-working" },
      { key: "u", label: "unstaged", command: "magit-diff-unstaged" },
      { key: "s", label: "staged", command: "magit-diff-staged" },
    ] },
  ],
}

const magitStashTransient: TransientDefinition = {
  name: "magit-stash",
  title: "Stash",
  groups: [
    { title: "Arguments", infixes: [{ key: "- u", label: "include untracked", argument: "--include-untracked" }] },
    { title: "Actions", suffixes: [
      { key: "z", label: "stash", command: "magit-stash" },
      { key: "s", label: "stash with message", command: "magit-stash-save" },
      { key: "p", label: "pop", command: "magit-stash-pop" },
      { key: "a", label: "apply", command: "magit-stash-apply" },
      { key: "k", label: "drop", command: "magit-stash-drop" },
      { key: "l", label: "list", command: "magit-stash-list" },
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
  ] }],
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

function defineTransientCommand(editor: Editor, command: string, definition: TransientDefinition, description: string): void {
  editor.command(command, ({ editor }) => editor.openTransient(definition), description)
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  // Read-only magit buffers must not fall through to self-insert on stray
  // printables (t-e061bdb3). The kernel's self-insert fallback is unconditional,
  // so the only mode-level lever is to claim those keys first. Binding them in a
  // *parent* mode keeps prefix sequences in the child maps (c c, l l, S-p p, …)
  // reachable — KeymapStack.lookup checks the child's hasPrefix before
  // descending. This is the moral equivalent of Emacs special-mode's
  // suppress-keymap.
  const suppressMap = new Keymap("magit-section-mode-map")
  suppressMap.bind("space", "magit-undefined")
  for (let c = 0x21; c <= 0x7e; c++) suppressMap.bind(String.fromCharCode(c), "magit-undefined")
  for (let c = 0x61; c <= 0x7a; c++) suppressMap.bind(`S-${String.fromCharCode(c)}`, "magit-undefined")
  defineMode({ name: "magit-section-mode", keymap: suppressMap })

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
  magitModeMap.bind("S-d", "magit-diff-refresh")
  magitModeMap.bind("g", "magit-refresh")
  magitModeMap.bind("S-g", "magit-refresh-all")
  magitModeMap.bind("h", "magit-dispatch")
  magitModeMap.bind("?", "magit-dispatch")
  magitModeMap.bind("q", "magit-bury-buffer")
  magitModeMap.bind(":", "magit-git-command")
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
  statusMap.bind("l l", "magit-log")
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
  statusMap.bind("m m", "magit-merge")
  statusMap.bind("m a", "magit-merge-abort")
  statusMap.bind("r r", "magit-rebase-continue")
  statusMap.bind("r c", "magit-rebase-continue")
  statusMap.bind("r s", "magit-rebase-skip")
  statusMap.bind("r a", "magit-rebase-abort")
  statusMap.bind("r e", "magit-rebase")
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
  statusMap.bind("c e", "magit-commit-extend")
  statusMap.bind("c w", "magit-commit-reword")
  statusMap.bind("d d", "magit-diff-working")
  statusMap.bind("d u", "magit-diff-unstaged")
  statusMap.bind("d s", "magit-diff-staged")
  statusMap.bind("n", "next-line")
  statusMap.bind("p", "previous-line")
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
  statusMap.bind("q", "magit-bury-buffer")
  statusMap.bind("tab", "magit-section-toggle")
  statusMap.bind("c", "magit-commit-popup")
  statusMap.bind("b", "magit-branch-popup")
  statusMap.bind("S-p", "magit-push-popup")
  statusMap.bind("S-f", "magit-pull-popup")
  statusMap.bind("f", "magit-fetch-popup")
  statusMap.bind("l", "magit-log-popup")
  statusMap.bind("d", "magit-diff-popup")
  statusMap.bind("z", "magit-stash-popup")
  statusMap.bind("x", "magit-reset-popup")
  statusMap.bind("S-x", "magit-reset-popup")
  statusMap.bind("m", "magit-merge-popup")
  statusMap.bind("r", "magit-rebase-popup")
  statusMap.bind("S-a", "magit-cherry-pick-popup")
  statusMap.bind("S-v", "magit-revert-popup")
  statusMap.bind("t", "magit-tag-popup")
  statusMap.bind("S-m", "magit-remote-popup")
  defineMode({ name: "magit-status", parent: "magit-mode", keymap: statusMap, fontLock: magitDiffFontLock })

  const commitMap = new Keymap("magit-commit-map")
  commitMap.bind("C-c C-c", "magit-commit-finish")
  commitMap.bind("C-c C-d", "magit-diff-while-committing")
  commitMap.bind("C-c C-k", "magit-commit-abort")
  defineMode({ name: "magit-commit", parent: "text", keymap: commitMap })

  const logMap = new Keymap("magit-log-map")
  logMap.bind("return", "magit-log-show-commit")
  logMap.bind("RET", "magit-log-show-commit")
  logMap.bind("g", "magit-log")
  logMap.bind("q", "magit-bury-buffer")
  defineMode({ name: "magit-log", parent: "magit-mode", keymap: logMap, fontLock: magitDiffFontLock })

  const revisionMap = new Keymap("magit-revision-mode-map")
  revisionMap.bind("j", "magit-revision-jump")
  revisionMap.bind("q", "magit-bury-buffer")
  defineMode({ name: "magit-revision-mode", parent: "magit-diff-mode", keymap: revisionMap, fontLock: magitDiffFontLock })

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
    const patch = diffArgs ? (await git([...diffArgs, ...magitDiffContextArgs(magitDiffContext(buffer)), "-p"], root)).out : buffer.text
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
  defineTransientCommand(editor, "magit-merge-popup", magitMergeTransient, "Show the Magit merge popup.")
  defineTransientCommand(editor, "magit-rebase-popup", magitRebaseTransient, "Show the Magit rebase popup.")
  defineTransientCommand(editor, "magit-cherry-pick-popup", magitCherryPickTransient, "Show the Magit cherry-pick popup.")
  defineTransientCommand(editor, "magit-revert-popup", magitRevertTransient, "Show the Magit revert popup.")
  defineTransientCommand(editor, "magit-tag-popup", magitTagTransient, "Show the Magit tag popup.")
  defineTransientCommand(editor, "magit-remote-popup", magitRemoteTransient, "Show the Magit remote popup.")

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
    await refresh(editor, root)
  }, "Refresh the current Magit status buffer.")

  editor.command("magit-stage", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) {
      editor.message("Nothing to stage at point")
      return
    }
    const hunk = hunkAtPoint(buffer)
    if (hunk && !hunk.staged) {
      const { err, code } = await git(["apply", "--cached", "-"], root, hunk.patch)
      if (code !== 0) {
        editor.message(`git apply failed: ${err.trim()}`)
        return
      }
      await refresh(editor, root)
      editor.message(`Staged hunk in ${hunk.file}`)
      return
    }
    const entry = entryAtPoint(buffer)
    if (!entry || entry.staged) {
      editor.message("Nothing to stage at point")
      return
    }
    await git(["add", "--", entry.file], root)
    await refresh(editor, root)
    editor.message(`Staged ${entry.file}`)
  }, "Stage the hunk or file at point.")

  editor.command("magit-unstage", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) {
      editor.message("Nothing to unstage at point")
      return
    }
    const hunk = hunkAtPoint(buffer)
    if (hunk && hunk.staged) {
      const { err, code } = await git(["apply", "--cached", "--reverse", "-"], root, hunk.patch)
      if (code !== 0) {
        editor.message(`git apply failed: ${err.trim()}`)
        return
      }
      await refresh(editor, root)
      editor.message(`Unstaged hunk in ${hunk.file}`)
      return
    }
    const entry = entryAtPoint(buffer)
    if (!entry || !entry.staged) {
      editor.message("Nothing to unstage at point")
      return
    }
    await git(["restore", "--staged", "--", entry.file], root)
    await refresh(editor, root)
    editor.message(`Unstaged ${entry.file}`)
  }, "Unstage the hunk or file at point.")

  editor.command("magit-commit", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) {
      editor.message("Not in a Magit buffer")
      return
    }
    const winconf = editor.currentWindowConfiguration()
    const buf = editor.scratch("*COMMIT_EDITMSG*", "", "magit-commit")
    buf.locals.set("magit-root", root)
    buf.locals.set("magit-winconf", winconf)
    buf.locals.set("magit-commit-args", args)
    buf.point = 0
    // Show what's being committed in a split, like real magit.
    await showCommitDiff(editor, buf)
    editor.message("Type C-c C-c to finish, C-c C-k to abort")
  }, "Open a buffer to write a commit message for staged changes.")

  editor.command("magit-commit-finish", async ({ editor, buffer }) => {
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
    const { err, code } = await git(["commit", ...extra.filter(arg => arg === "--signoff"), "-F", "-"], root, msg)
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

  editor.command("magit-commit-abort", ({ editor, buffer }) => {
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
    const { out } = await git(["rev-parse", "--abbrev-ref", "HEAD"], root)
    const current = out.trim() || "HEAD"
    const setUpstream = args.includes("--set-upstream")
    const explicit = args.filter(arg => arg !== "--set-upstream")
    const remote = explicit[0] ?? await editor.prompt("Push to remote: ", "origin", "magit-push-remote")
    if (remote == null) return
    const branch = explicit[1] ?? await editor.prompt("Push branch: ", current, "magit-push-branch")
    if (branch == null) return
    const { err, code } = await git(["push", ...(setUpstream ? ["--set-upstream"] : []), refname(remote), refname(branch)], root)
    if (code !== 0) {
      editor.message(`git push failed: ${err.trim()}`)
      return
    }
    await refresh(editor, root)
    editor.message(`Pushed ${branch} to ${remote}`)
  }, "Push the current branch, prompting for remote and branch.")

  editor.command("magit-log", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) {
      editor.message("Not in a Magit buffer")
      return
    }
    await openLog(editor, root, buffer)
  }, "Show recent history in a *magit-log* buffer.")

  editor.command("magit-log-show-commit", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    const sha = logShaAtPoint(buffer)
    if (!root || !sha) {
      editor.message("No commit at point")
      return
    }
    const { out } = await git(["show", "--stat", "-p", sha], root)
    const logWindow = editor.selectedWindowId
    editor.splitWindowBelow()
    editor.selectWindow(nextWindowId(editor.windowLayout, editor.selectedWindowId, 1))
    const buf = editor.scratch(`*magit-commit: ${sha}*`, out, "magit-revision-mode")
    buf.readOnly = true
    buf.locals.set("magit-root", root)
    buf.locals.set("magit-diff-args", ["diff", `${sha}^!`])
    pushMagitHistory(buf, buffer)
    buf.point = 0
    editor.selectWindow(logWindow)
  }, "Show the commit at point in a split below, keeping the log selected.")

  editor.command("magit-branch-checkout", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) {
      editor.message("Not in a Magit buffer")
      return
    }
    const { out } = await git(["branch", "--list", "--format=%(refname:short)"], root)
    const branches = out.split("\n").filter(Boolean)
    const target = args[0] ?? await editor.completingRead("Checkout branch: ", { collection: branches, history: "magit-branch" })
    if (!target) return
    const { err, code } = await git(["checkout", refname(target)], root)
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
    const { err, code } = await git(["checkout", "-b", refname(name)], root)
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
    const { out, err, code } = await git(["stash", "push", ...(args.includes("--include-untracked") ? ["--include-untracked"] : [])], root)
    if (code !== 0) {
      editor.message(`git stash failed: ${err.trim()}`)
      return
    }
    await refresh(editor, root, 0)
    editor.message(out.trim() || "Stashed")
  }, "Stash working tree changes.")

  editor.command("magit-stash-pop", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) {
      editor.message("Not in a Magit buffer")
      return
    }
    const { err, code } = await git(["stash", "pop"], root)
    if (code !== 0) {
      editor.message(`git stash pop failed: ${err.trim()}`)
      return
    }
    await refresh(editor, root)
    editor.message("Popped stash")
  }, "Pop the most recent stash.")

  editor.command("magit-discard", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    const entry = entryAtPoint(buffer)
    if (!root || !entry || entry.staged) {
      editor.message("Nothing to discard at point")
      return
    }
    const ans = await editor.prompt(`Discard changes in ${entry.file}? (y or n) `)
    if (ans !== "y") {
      editor.message("Discard cancelled")
      return
    }
    if (entry.untracked) {
      // No HEAD/index version to restore — discarding an untracked file means removing it.
      try {
        await unlink(join(root, entry.file))
      } catch (e) {
        editor.message(`Discard failed: ${(e as Error).message}`)
        return
      }
    } else {
      const { err, code } = await git(["checkout", "--", entry.file], root)
      if (code !== 0) {
        editor.message(`git checkout failed: ${err.trim()}`)
        return
      }
    }
    await refresh(editor, root)
    editor.message(`Discarded ${entry.file}`)
  }, "Discard unstaged changes to the file at point (with confirmation).")

  editor.command("magit-reset-quickly", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) {
      editor.message("Not in a Magit buffer")
      return
    }
    const { err, code } = await git(["reset", "HEAD", "--"], root)
    if (code !== 0) {
      editor.message(`git reset failed: ${err.trim()}`)
      return
    }
    await refresh(editor, root)
    editor.message("Reset index to HEAD")
  }, "Unstage all staged changes (reset index to HEAD).")

  editor.command("magit-reset", async ({ editor, buffer }) => {
    await editor.run("magit-reset-quickly")
  }, "Unstage all staged changes (reset index to HEAD).")

  const resetIndex = async (editor: Editor, root: string, mode: string, label: string) => {
    const { err, code } = await git(["reset", mode, "HEAD"], root)
    if (code !== 0) {
      editor.message(`git reset failed: ${err.trim()}`)
      return
    }
    await refresh(editor, root, 0)
    editor.message(label)
  }

  editor.command("magit-reset-mixed", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    await resetIndex(editor, root, "--mixed", "Reset mixed to HEAD")
  }, "Reset mixed to HEAD.")

  editor.command("magit-reset-soft", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    await resetIndex(editor, root, "--soft", "Reset soft to HEAD")
  }, "Reset soft to HEAD.")

  editor.command("magit-reset-hard", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const ans = await editor.prompt("Hard reset to HEAD? (y or n) ")
    if (ans !== "y") return editor.message("Reset cancelled")
    await resetIndex(editor, root, "--hard", "Reset hard to HEAD")
  }, "Reset hard to HEAD (with confirmation).")

  editor.command("magit-stage-modified", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const { err, code } = await git(["add", "-u"], root)
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

  const remoteDefault = async (root: string, kind: "push" | "upstream"): Promise<string> => {
    const { out: branch } = await git(["rev-parse", "--abbrev-ref", "HEAD"], root)
    const b = branch.trim()
    if (kind === "upstream") {
      const { out } = await git(["rev-parse", "--abbrev-ref", `${b}@{upstream}`], root)
      const up = out.trim()
      if (up.includes("/")) return up.split("/")[0]!
    }
    const { out } = await git(["remote"], root)
    return out.split("\n").find(Boolean) ?? "origin"
  }

  editor.command("magit-fetch-from-pushremote", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const remote = await remoteDefault(root, "push")
    const { err, code } = await git(["fetch", refname(remote)], root)
    if (code !== 0) return editor.message(`git fetch failed: ${err.trim()}`)
    await refresh(editor, root)
    editor.message(`Fetched from ${remote}`)
  }, "Fetch from push-remote.")

  editor.command("magit-fetch-from-upstream", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const remote = await remoteDefault(root, "upstream")
    const { err, code } = await git(["fetch", refname(remote)], root)
    if (code !== 0) return editor.message(`git fetch failed: ${err.trim()}`)
    await refresh(editor, root)
    editor.message(`Fetched from ${remote}`)
  }, "Fetch from upstream remote.")

  editor.command("magit-fetch-all", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const { err, code } = await git(["fetch", "--all"], root)
    if (code !== 0) return editor.message(`git fetch failed: ${err.trim()}`)
    await refresh(editor, root)
    editor.message("Fetched all remotes")
  }, "Fetch from all remotes.")

  editor.command("magit-pull-from-upstream", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const remote = await remoteDefault(root, "upstream")
    const { out } = await git(["rev-parse", "--abbrev-ref", "HEAD"], root)
    const branch = out.trim()
    const { err, code } = await git(["pull", refname(remote), refname(branch)], root)
    if (code !== 0) return editor.message(`git pull failed: ${err.trim()}`)
    await refresh(editor, root, 0)
    editor.message(`Pulled ${branch} from ${remote}`)
  }, "Pull from upstream.")

  editor.command("magit-pull-from-pushremote", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const remote = await remoteDefault(root, "push")
    const { out } = await git(["rev-parse", "--abbrev-ref", "HEAD"], root)
    const branch = out.trim()
    const { err, code } = await git(["pull", refname(remote), refname(branch)], root)
    if (code !== 0) return editor.message(`git pull failed: ${err.trim()}`)
    await refresh(editor, root, 0)
    editor.message(`Pulled ${branch} from ${remote}`)
  }, "Pull from push-remote.")

  editor.command("magit-push-upstream", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const remote = await remoteDefault(root, "upstream")
    const { out } = await git(["rev-parse", "--abbrev-ref", "HEAD"], root)
    const branch = out.trim()
    const { err, code } = await git(["push", ...(args.includes("--set-upstream") ? ["--set-upstream"] : []), refname(remote), refname(branch)], root)
    if (code !== 0) return editor.message(`git push failed: ${err.trim()}`)
    await refresh(editor, root)
    editor.message(`Pushed ${branch} to ${remote}`)
  }, "Push to upstream remote.")

  editor.command("magit-commit-amend", async ({ editor, buffer, args: commandArgs }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const msg = await editor.prompt("Amend commit message: ", "", "magit-commit-amend")
    if (msg == null) return
    const signoff = commandArgs.includes("--signoff") ? ["--signoff"] : []
    const args = msg.trim() ? ["commit", "--amend", ...signoff, "-m", msg] : ["commit", "--amend", ...signoff, "--no-edit"]
    const { err, code } = await git(args, root)
    if (code !== 0) return editor.message(`git commit --amend failed: ${err.trim()}`)
    await refresh(editor, root, 0)
    editor.message("Amended commit")
  }, "Amend the last commit.")

  editor.command("magit-stash-save", async ({ editor, buffer, args: commandArgs }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const msg = await editor.prompt("Stash message: ", "", "magit-stash")
    if (msg == null) return
    const includeUntracked = commandArgs.includes("--include-untracked") ? ["--include-untracked"] : []
    const args = msg.trim() ? ["stash", "push", ...includeUntracked, "-m", msg] : ["stash", "push", ...includeUntracked]
    const { err, code } = await git(args, root)
    if (code !== 0) return editor.message(`git stash failed: ${err.trim()}`)
    await refresh(editor, root, 0)
    editor.message("Saved stash")
  }, "Stash with optional message.")

  editor.command("magit-log-refresh", async ({ editor, buffer }) => {
    await editor.run("magit-log")
  }, "Refresh or open log buffer.")

  editor.command("magit-visit-thing", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Nothing to visit at point")
    const entry = entryAtPoint(buffer)
    if (entry) {
      await editor.openFile(join(root, entry.file))
      return
    }
    const sha = logShaAtPoint(buffer)
    if (sha) {
      await editor.run("magit-log-show-commit")
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
    const { err, code } = await git(["init"], start)
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
    const buf = editor.scratch("*magit-process*", (out + err) || `(exit ${code})\n`, "magit-revision-mode")
    buf.readOnly = true
    buf.locals.set("magit-root", root)
    pushMagitHistory(buf, buffer)
    buf.point = 0
    editor.message(code === 0 ? "Command finished" : `Command failed (${code})`)
  }, "Run an arbitrary git/shell command.")

  editor.command("magit-section-toggle", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    const entry = entryAtPoint(buffer)
    if (!root || !entry) {
      editor.message("Nothing to fold at point")
      return
    }
    const folded = (buffer.locals.get("magit-folded") as Set<string> | undefined) ?? new Set<string>()
    const key = foldKey(entry.file, entry.staged)
    if (folded.has(key)) folded.delete(key)
    else folded.add(key)
    buffer.locals.set("magit-folded", folded)
    // Re-render with the new fold set; place point on the entry's header so a
    // second TAB on the same key toggles back regardless of the diff body length.
    // Match the buffer's diff context so line offsets agree with what refresh() shows.
    const status = await buildStatus(root, folded, magitDiffContext(buffer))
    const next = status.entries.find(e => e.file === entry.file && e.staged === entry.staged)
    await refresh(editor, root, next ? lineToPoint(status.text, next.startLine) : buffer.point)
  }, "Toggle section at point (fold/unfold diff).")

  editor.command("magit-toggle-fold", async ({ editor, buffer }) => {
    await editor.run("magit-section-toggle")
  }, "Alias for magit-section-toggle.")

  editor.command("magit-mode-bury-buffer", async ({ editor }) => {
    await editor.run("previous-buffer")
  }, "Bury the current Magit buffer.")

  editor.command("magit-bury-buffer", async ({ editor }) => {
    await editor.run("magit-mode-bury-buffer")
  }, "Alias for magit-mode-bury-buffer.")

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
    const { err, code } = await git(args, root)
    if (code !== 0) { editor.message(`git ${args[0]} failed: ${err.trim()}`); return }
    await refresh(editor, root, opts.resetPoint ? 0 : undefined)
    editor.message(ok)
  }

  const branchList = async (root: string, includeRemotes = false): Promise<string[]> => {
    const args = includeRemotes
      ? ["branch", "-a", "--format=%(refname:short)"]
      : ["branch", "--list", "--format=%(refname:short)"]
    const { out } = await git(args, root)
    return out.split("\n").filter(Boolean)
  }

  editor.command("magit-merge", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const branch = args[0] ?? await editor.completingRead("Merge branch: ", { collection: await branchList(root, true), history: "magit-merge" })
    if (!branch) return
    await runGit(editor, buffer, ["merge", refname(branch)], `Merged ${branch}`, { resetPoint: true })
  }, "Merge another branch into the current branch.")

  editor.command("magit-merge-abort", async ({ editor, buffer }) => {
    await runGit(editor, buffer, ["merge", "--abort"], "Merge aborted", { resetPoint: true })
  }, "Abort an in-progress merge.")

  editor.command("magit-rebase", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const onto = args[0] ?? await editor.completingRead("Rebase onto: ", { collection: await branchList(root, true), history: "magit-rebase" })
    if (!onto) return
    await runGit(editor, buffer, ["rebase", refname(onto)], `Rebased onto ${onto}`, { resetPoint: true })
  }, "Rebase the current branch onto another branch.")

  editor.command("magit-rebase-continue", async ({ editor, buffer }) => {
    await runGit(editor, buffer, ["rebase", "--continue"], "Rebase continued", { resetPoint: true })
  }, "Continue an in-progress rebase.")

  editor.command("magit-rebase-skip", async ({ editor, buffer }) => {
    await runGit(editor, buffer, ["rebase", "--skip"], "Skipped commit", { resetPoint: true })
  }, "Skip the current commit during a rebase.")

  editor.command("magit-rebase-abort", async ({ editor, buffer }) => {
    await runGit(editor, buffer, ["rebase", "--abort"], "Rebase aborted", { resetPoint: true })
  }, "Abort an in-progress rebase.")

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
    const sha = args[0] ?? logShaAtPoint(buffer)
    if (!sha) return editor.message("No commit at point")
    await runGit(editor, buffer, ["revert", "--no-edit", refname(sha)], `Reverted ${sha}`, { resetPoint: true })
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
    await runGit(editor, buffer, ["tag", refname(name), refname(rev)], `Tagged ${name}`)
  }, "Create a tag at the commit at point (or HEAD).")

  editor.command("magit-tag-delete", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const { out } = await git(["tag", "--list"], root)
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
    const { out } = await git(["remote"], root)
    const name = args[0] ?? await editor.completingRead("Remove remote: ", { collection: out.split("\n").filter(Boolean), history: "magit-remote" })
    if (!name) return
    await runGit(editor, buffer, ["remote", "remove", refname(name)], `Removed remote ${name}`)
  }, "Remove a remote.")

  editor.command("magit-remote-rename", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const { out } = await git(["remote"], root)
    const old = args[0] ?? await editor.completingRead("Rename remote: ", { collection: out.split("\n").filter(Boolean), history: "magit-remote" })
    if (!old) return
    const next = args[1] ?? await editor.prompt(`Rename ${old} to: `, "", "magit-remote")
    if (!next) return
    await runGit(editor, buffer, ["remote", "rename", refname(old), refname(next)], `Renamed ${old} to ${next}`)
  }, "Rename a remote.")

  editor.command("magit-branch-delete", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const branch = args[0] ?? await editor.completingRead("Delete branch: ", { collection: await branchList(root), history: "magit-branch" })
    if (!branch) return
    await runGit(editor, buffer, ["branch", "-d", refname(branch)], `Deleted branch ${branch}`)
  }, "Delete a branch.")

  editor.command("magit-branch-rename", async ({ editor, buffer, args }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const old = args[0] ?? await editor.completingRead("Rename branch: ", { collection: await branchList(root), history: "magit-branch" })
    if (!old) return
    const next = args[1] ?? await editor.prompt(`Rename ${old} to: `, "", "magit-branch")
    if (!next) return
    await runGit(editor, buffer, ["branch", "-m", refname(old), refname(next)], `Renamed ${old} to ${next}`, { resetPoint: true })
  }, "Rename a branch.")

  editor.command("magit-stash-apply", async ({ editor, buffer }) => {
    await runGit(editor, buffer, ["stash", "apply"], "Applied stash")
  }, "Apply the most recent stash without dropping it.")

  editor.command("magit-stash-drop", async ({ editor, buffer }) => {
    await runGit(editor, buffer, ["stash", "drop"], "Dropped stash", { confirm: "Drop stash@{0}? (y or n) " })
  }, "Drop the most recent stash (with confirmation).")

  editor.command("magit-stash-list", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const { out } = await git(["stash", "list"], root)
    const buf = editor.scratch("*magit-stash-list*", out || "(no stashes)\n", "magit-revision-mode")
    buf.readOnly = true
    buf.locals.set("magit-root", root)
    pushMagitHistory(buf, buffer)
    buf.point = 0
  }, "List stashes in a buffer.")

  editor.command("magit-commit-extend", async ({ editor, buffer }) => {
    await runGit(editor, buffer, ["commit", "--amend", "--no-edit"], "Extended commit", { resetPoint: true })
  }, "Add staged changes to HEAD without editing the message.")

  editor.command("magit-commit-reword", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const { out } = await git(["log", "-1", "--pretty=%B"], root)
    const msg = await editor.prompt("Reword commit: ", out.trim(), "magit-commit-reword")
    if (msg == null || !msg.trim()) return editor.message("Reword cancelled")
    await runGit(editor, buffer, ["commit", "--amend", "--only", "-m", msg], "Reworded commit", { resetPoint: true })
  }, "Edit the message of HEAD without changing its tree.")

  const openDiff = async (editor: Editor, buffer: BufferModel, gitArgs: string[], title: string) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const context = magitDiffContext(buffer)
    const { out } = await git([...gitArgs, ...magitDiffContextArgs(context)], root)
    const buf = editor.scratch(`*magit-diff: ${title}*`, out || "(no changes)\n", "magit-diff-mode")
    buf.readOnly = true
    buf.locals.set("magit-root", root)
    buf.locals.set("magit-diff-args", gitArgs)
    buf.locals.set("magit-diff-title", title)
    buf.locals.set("magit-diff-context", context)
    pushMagitHistory(buf, buffer)
    buf.point = 0
  }

  editor.command("magit-diff-working", async ({ editor, buffer }) => {
    await openDiff(editor, buffer, ["diff", "HEAD"], "working tree")
  }, "Show the diff of the working tree against HEAD.")

  editor.command("magit-diff-unstaged", async ({ editor, buffer }) => {
    await openDiff(editor, buffer, ["diff"], "unstaged")
  }, "Show unstaged changes.")

  editor.command("magit-diff-staged", async ({ editor, buffer }) => {
    await openDiff(editor, buffer, ["diff", "--cached"], "staged")
  }, "Show staged changes.")

  editor.key("C-x g", "magit-status")
  editor.key("C-c g", "magit-dispatch")
}

function lineToPoint(text: string, line: number): number {
  let pos = 0
  for (let i = 0; i < line; i++) {
    const nl = text.indexOf("\n", pos)
    if (nl < 0) return text.length
    pos = nl + 1
  }
  return pos
}
