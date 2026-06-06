import { basename, join } from "node:path"
import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { BufferModel } from "../../src/kernel/buffer"
import { defineMode, type TextSpan } from "../../src/modes/mode"
import { Keymap } from "../../src/kernel/keymap"
import { spawnProcess } from "../../src/platform/runtime"
import { projectRoot } from "../project"

/** A file-level section in the status buffer; line ranges let s/u act on the diff body too. */
export type MagitEntry = {
  file: string
  staged: boolean
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

function foldKey(file: string, staged: boolean): string {
  return `${staged ? "S" : "U"}:${file}`
}

export async function buildStatus(root: string, folded: ReadonlySet<string> = new Set()): Promise<MagitStatus> {
  const [status, headMsg, unstagedDiff, stagedDiff, log, stashList] = await Promise.all([
    git(["status", "--porcelain=v2", "--branch"], root),
    git(["log", "-1", "--pretty=%s"], root),
    git(["diff"], root),
    git(["diff", "--cached"], root),
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
      entries.push({ file: f.file, staged: isStaged, startLine: start, endLine: lines.length - 1 })
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
  const status = await buildStatus(root, folded)
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
  buf.point = Math.min(keepPoint, buf.text.length)
  return buf
}

function magitRoot(buffer: BufferModel): string | null {
  return (buffer.locals.get("magit-root") as string | undefined) ?? null
}

/** Line-based diff highlighting for status/revision buffers; repurposes existing faces (string=added, error=removed). */
export function magitDiffFontLock(buffer: BufferModel): TextSpan[] {
  const spans: TextSpan[] = []
  let offset = 0
  for (const line of buffer.text.split("\n")) {
    const end = offset + line.length
    if (line.startsWith("@@")) spans.push({ start: offset, end, face: "builtin" })
    else if (line.startsWith("+++") || line.startsWith("---")) spans.push({ start: offset, end, face: "comment" })
    else if (line.startsWith("+")) spans.push({ start: offset, end, face: "string" })
    else if (line.startsWith("-")) spans.push({ start: offset, end, face: "error" })
    else if (/^(Head|Merge|Unstaged|Staged|Stashes|Recent)\b/.test(line)) spans.push({ start: offset, end, face: "keyword" })
    offset = end + 1
  }
  return spans
}

/** Extract the 7+ hex sha at point from a `--graph --oneline` line. */
export function logShaAtPoint(buffer: BufferModel): string | null {
  const line = lineAt(buffer)
  const text = buffer.text.split("\n")[line] ?? ""
  return /\b([0-9a-f]{7,40})\b/.exec(text)?.[1] ?? null
}

async function openLog(editor: Editor, root: string): Promise<BufferModel> {
  const { out } = await git(["log", "--oneline", "--graph", "-50"], root)
  const buf = editor.scratch("*magit-log*", out || "(no commits)\n", "magit-log")
  buf.readOnly = true
  buf.path = root
  buf.locals.set("magit-root", root)
  buf.point = 0
  return buf
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  // Read-only magit buffers must not fall through to self-insert on stray
  // printables (t-e061bdb3). The kernel's self-insert fallback is unconditional,
  // so the only mode-level lever is to claim those keys first. Binding them in a
  // *parent* mode keeps prefix sequences in the child maps (c c, l l, S-p p, …)
  // reachable — KeymapStack.lookup checks the child's hasPrefix before
  // descending. This is the moral equivalent of Emacs special-mode's
  // suppress-keymap.
  const suppressMap = new Keymap("magit-special-map")
  suppressMap.bind("space", "magit-undefined")
  for (let c = 0x21; c <= 0x7e; c++) suppressMap.bind(String.fromCharCode(c), "magit-undefined")
  for (let c = 0x61; c <= 0x7a; c++) suppressMap.bind(`S-${String.fromCharCode(c)}`, "magit-undefined")
  defineMode({ name: "magit-special", keymap: suppressMap })

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
  statusMap.bind("x", "magit-reset")
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
  defineMode({ name: "magit-status", parent: "magit-special", keymap: statusMap, fontLock: magitDiffFontLock })

  const commitMap = new Keymap("magit-commit-map")
  commitMap.bind("C-c C-c", "magit-commit-finish")
  commitMap.bind("C-c C-k", "magit-commit-abort")
  defineMode({ name: "magit-commit", parent: "text", keymap: commitMap })

  const logMap = new Keymap("magit-log-map")
  logMap.bind("return", "magit-log-show-commit")
  logMap.bind("RET", "magit-log-show-commit")
  logMap.bind("g", "magit-log")
  logMap.bind("q", "magit-bury-buffer")
  defineMode({ name: "magit-log", parent: "magit-special", keymap: logMap, fontLock: magitDiffFontLock })

  const revisionMap = new Keymap("magit-revision-map")
  revisionMap.bind("q", "magit-bury-buffer")
  defineMode({ name: "magit-revision", parent: "magit-special", keymap: revisionMap, fontLock: magitDiffFontLock })

  editor.command("magit-undefined", ({ editor }) => {
    editor.message("Buffer is read-only")
  }, "No-op for unbound printable keys in read-only Magit buffers.")

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

  editor.command("magit-commit", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) {
      editor.message("Not in a Magit buffer")
      return
    }
    const winconf = editor.currentWindowConfiguration()
    const { out: diff } = await git(["diff", "--cached"], root)
    const buf = editor.scratch("*COMMIT_EDITMSG*", "", "magit-commit")
    buf.locals.set("magit-root", root)
    buf.locals.set("magit-winconf", winconf)
    buf.point = 0
    // Show what's being committed in a split, like real magit.
    const msgWindow = editor.selectedWindowId
    editor.splitWindowBelow()
    const diffBuf = editor.scratch("*magit-diff: staged*", diff || "(nothing staged)\n", "magit-revision")
    diffBuf.readOnly = true
    diffBuf.point = 0
    editor.selectWindow(msgWindow)
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
    const { err, code } = await git(["commit", "-F", "-"], root, msg)
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
    const remote = args[0] ?? await editor.prompt("Push to remote: ", "origin", "magit-push-remote")
    if (remote == null) return
    const branch = args[1] ?? await editor.prompt("Push branch: ", current, "magit-push-branch")
    if (branch == null) return
    const { err, code } = await git(["push", refname(remote), refname(branch)], root)
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
    await openLog(editor, root)
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
    const buf = editor.scratch(`*magit-commit: ${sha}*`, out, "magit-revision")
    buf.readOnly = true
    buf.locals.set("magit-root", root)
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

  editor.command("magit-stash", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) {
      editor.message("Not in a Magit buffer")
      return
    }
    const { out, err, code } = await git(["stash", "push"], root)
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
    const { err, code } = await git(["checkout", "--", entry.file], root)
    if (code !== 0) {
      editor.message(`git checkout failed: ${err.trim()}`)
      return
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

  editor.command("magit-push-upstream", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const remote = await remoteDefault(root, "upstream")
    const { out } = await git(["rev-parse", "--abbrev-ref", "HEAD"], root)
    const branch = out.trim()
    const { err, code } = await git(["push", refname(remote), refname(branch)], root)
    if (code !== 0) return editor.message(`git push failed: ${err.trim()}`)
    await refresh(editor, root)
    editor.message(`Pushed ${branch} to ${remote}`)
  }, "Push to upstream remote.")

  editor.command("magit-commit-amend", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const msg = await editor.prompt("Amend commit message: ", "", "magit-commit-amend")
    if (msg == null) return
    const args = msg.trim() ? ["commit", "--amend", "-m", msg] : ["commit", "--amend", "--no-edit"]
    const { err, code } = await git(args, root)
    if (code !== 0) return editor.message(`git commit --amend failed: ${err.trim()}`)
    await refresh(editor, root, 0)
    editor.message("Amended commit")
  }, "Amend the last commit.")

  editor.command("magit-stash-save", async ({ editor, buffer }) => {
    const root = magitRoot(buffer)
    if (!root) return editor.message("Not in a Magit buffer")
    const msg = await editor.prompt("Stash message: ", "", "magit-stash")
    if (msg == null) return
    const args = msg.trim() ? ["stash", "push", "-m", msg] : ["stash", "push"]
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
    editor.message("Magit: g refresh  s/u stage  c c commit  c e extend  P p push  F u pull  f u fetch  l l log  d d diff  b b/c/k/m branch  m m merge  r e/a rebase  A a cherry-pick  V v revert  t t tag  M a remote  z z stash  k discard  x reset  RET visit  TAB fold  n/p move  q bury")
  }, "Show Magit command summary.")

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
    const buf = editor.scratch("*magit-process*", (out + err) || `(exit ${code})\n`, "magit-revision")
    buf.readOnly = true
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
    const status = await buildStatus(root, folded)
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
    const buf = editor.scratch("*magit-stash-list*", out || "(no stashes)\n", "magit-revision")
    buf.readOnly = true
    buf.locals.set("magit-root", root)
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
    const { out } = await git(gitArgs, root)
    const buf = editor.scratch(`*magit-diff: ${title}*`, out || "(no changes)\n", "magit-revision")
    buf.readOnly = true
    buf.locals.set("magit-root", root)
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
