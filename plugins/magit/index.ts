import { basename } from "node:path"
import type { Editor } from "../../src/kernel/editor"
import type { BufferModel } from "../../src/kernel/buffer"
import { defineMode } from "../../src/modes/mode"
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
  const [status, headMsg, unstagedDiff, stagedDiff, log] = await Promise.all([
    git(["status", "--porcelain=v2", "--branch"], root),
    git(["log", "-1", "--pretty=%s"], root),
    git(["diff"], root),
    git(["diff", "--cached"], root),
    git(["log", "-n", "10", "--pretty=%h %s"], root),
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

export function install(editor: Editor): void {
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
  statusMap.bind("s", "magit-stage")
  statusMap.bind("u", "magit-unstage")
  statusMap.bind("g", "magit-refresh")
  statusMap.bind("c c", "magit-commit")
  statusMap.bind("q", "magit-bury-buffer")
  // keyToken() emits 'S-p' for Shift+P, but normalizeToken stores a bare 'P'
  // as 'p' — bind both spellings so the terminal event and the lowercase alias
  // both reach magit-push (t-26dfa2ae).
  statusMap.bind("P p", "magit-push")
  statusMap.bind("S-p p", "magit-push")
  statusMap.bind("l l", "magit-log")
  statusMap.bind("b b", "magit-branch-checkout")
  statusMap.bind("b c", "magit-branch-create")
  statusMap.bind("z z", "magit-stash")
  statusMap.bind("z p", "magit-stash-pop")
  statusMap.bind("k", "magit-discard")
  statusMap.bind("x", "magit-reset")
  statusMap.bind("tab", "magit-toggle-fold")
  defineMode({ name: "magit-status", parent: "magit-special", keymap: statusMap })

  const commitMap = new Keymap("magit-commit-map")
  commitMap.bind("C-c C-c", "magit-commit-finish")
  commitMap.bind("C-c C-k", "magit-commit-abort")
  defineMode({ name: "magit-commit", parent: "text", keymap: commitMap })

  const logMap = new Keymap("magit-log-map")
  logMap.bind("return", "magit-log-show-commit")
  logMap.bind("RET", "magit-log-show-commit")
  logMap.bind("g", "magit-log")
  logMap.bind("q", "magit-bury-buffer")
  defineMode({ name: "magit-log", parent: "magit-special", keymap: logMap })

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
    const diffBuf = editor.scratch("*magit-diff: staged*", diff || "(nothing staged)\n", "text")
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
    const buf = editor.scratch(`*magit-commit: ${sha}*`, out, "text")
    buf.readOnly = true
    buf.locals.set("magit-root", root)
    buf.point = 0
  }, "Show the commit at point.")

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

  editor.command("magit-reset", async ({ editor, buffer }) => {
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

  editor.command("magit-toggle-fold", async ({ editor, buffer }) => {
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
  }, "Toggle folding of the diff body for the file at point.")

  editor.command("magit-bury-buffer", ({ editor }) => {
    editor.previousBuffer()
  }, "Bury the Magit status buffer.")

  editor.key("C-x g", "magit-status")
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
