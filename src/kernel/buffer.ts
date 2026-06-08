import { dirname, basename } from "node:path"
import { copyFile, mkdir, stat } from "node:fs/promises"
import { fileExists, readFileText, writeFileText } from "../platform/runtime"
import { resolveBackupPath, type BackupDirectoryAlist } from "./backup-path"
import { isTransientMarkModeEnabled } from "./transient-mark"
import type { ShadowLink } from "../shadow/link"
import type { Splice } from "../shadow/ops"

export type BufferKind = "file" | "directory" | "scratch" | "messages" | "inspector" | "minibuffer" | "grep"

/** Editor capabilities save() needs, typed structurally to avoid the buffer↔editor cycle. */
export type SaveContext = {
  runHook?(name: string, buffer: BufferModel): Promise<void>
  confirm?(prompt: string): Promise<boolean>
  force?: boolean
  /** Resolved make-backup-files; the defcustom lives at the command layer to keep buffer.ts cycle-free. */
  makeBackupFiles?: boolean
  /** Resolved backup-directory-alist; same layering as makeBackupFiles. */
  backupDirectoryAlist?: BackupDirectoryAlist
}

type Op = { from: number; to: number; removed: string; inserted: string; point: number }
type UndoNode = { ops: Op[]; parent: UndoNode | null; children: UndoNode[]; seq: number }

export class BufferModel {
  readonly id: string
  name: string
  path?: string
  kind: BufferKind
  private _text: string
  /** Offsets of line starts (lineStarts[0] === 0). Incrementally maintained in `_splice`. */
  private _lineStarts!: number[]
  private _point = 0
  goalColumn: number | null = null
  mark: number | null = null
  markActive = false
  dirty = false
  readOnly = false
  mode = "text"
  /** mtimeMs of the visited file at last load/save; undefined if never read from disk. */
  visitedFileModtime?: number
  readonly minorModes = new Set<string>()
  readonly locals = new Map<string, unknown>()
  /** Set ⇒ this buffer's authoritative copy lives on the peer; save() etc. route via Cmd. */
  link?: ShadowLink
  onTextChange?: (event: { start: number; end: number; text: string }) => void
  /** Shadow send hook — fires per `_splice` with seq:0; the link layer assigns the real seq.
   *  Second arg carries `_splice`'s opts so the link layer can filter undo/redo/append
   *  (snapshot:false) to keep the pending↔undo-node 1:1 the rebase rewind relies on. */
  onSplice?: (s: Splice, opts: { snapshot?: boolean; markDirty?: boolean }) => void
  private nextSeq = 0
  private undoRoot: UndoNode = { ops: [], parent: null, children: [], seq: 0 }
  private undoCur: UndoNode = this.undoRoot
  /** Tree node at which text matches disk. */
  private savedNode: UndoNode = this.undoRoot
  private backedUp = false

  constructor(args: { id?: string; name: string; text?: string; path?: string; kind?: BufferKind; mode?: string }) {
    this.id = args.id ?? crypto.randomUUID()
    this.name = args.name
    this._text = args.text ?? ""
    this._lineStarts = scanLineStarts(this._text)
    this.path = args.path
    this.kind = args.kind ?? (args.path ? "file" : "scratch")
    this.mode = args.mode ?? inferMode(args.path ?? args.name)
  }

  static async fromFile(path: string): Promise<BufferModel> {
    const exists = await fileExists(path)
    const text = exists ? await readFileText(path) : ""
    const buf = new BufferModel({ name: basename(path), path, text, kind: "file", mode: inferMode(path) })
    if (exists) buf.visitedFileModtime = await fileModtime(path)
    return buf
  }

  directory(): string | undefined {
    if (!this.path) return undefined
    if (this.kind === "directory") return this.path
    return dirname(this.path)
  }

  get text(): string { return this._text }
  get lineStarts(): readonly number[] { return this._lineStarts }
  get lineCount(): number { return this._lineStarts.length }

  /** 0-indexed line containing `offset`. */
  lineAt(offset: number): number {
    const ls = this._lineStarts
    let lo = 0, hi = ls.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (ls[mid]! <= offset) lo = mid; else hi = mid - 1
    }
    return lo
  }

  /** [start, end) char range of 0-indexed `line` (end excludes the newline). */
  lineBounds(line: number): [number, number] {
    const ls = this._lineStarts
    const i = clamp(line, 0, ls.length - 1)
    const start = ls[i]!
    const end = i + 1 < ls.length ? ls[i + 1]! - 1 : this._text.length
    return [start, end]
  }

  lineCol(): { line: number; col: number } {
    const line = this.lineAt(this._point)
    return { line: line + 1, col: this._point - this._lineStarts[line]! + 1 }
  }

  private _spliceLineStarts(a: number, b: number, removed: string, repl: string): void {
    const ls = this._lineStarts
    // Lines whose starts fall inside (a, b] are gone; insert starts from repl's newlines.
    const firstAfterA = bsearchGT(ls, a)
    const firstAfterB = bsearchGT(ls, b)
    const inserted: number[] = []
    for (let i = 0; i < repl.length; i++) if (repl.charCodeAt(i) === 10) inserted.push(a + i + 1)
    const shift = repl.length - removed.length
    if (shift) for (let i = firstAfterB; i < ls.length; i++) ls[i]! += shift
    ls.splice(firstAfterA, firstAfterB - firstAfterA, ...inserted)
  }

  /** The single mutation funnel. Every text change routes through here so the
   *  invariant chain (assertWritable → snapshot → onTextChange → mutate →
   *  clamp point → adjust+clamp mark → deactivateMark) holds for all callers. */
  private _splice(from: number, to: number, repl: string, opts: { markDirty?: boolean; snapshot?: boolean } = {}): string {
    const len = this._text.length
    const a = clamp(Math.min(from, to), 0, len)
    const b = clamp(Math.max(from, to), 0, len)
    const markDirty = opts.markDirty ?? true
    if (a === b && !repl) return ""
    this.assertWritable(markDirty)
    const removed = this._text.slice(a, b)
    if (opts.snapshot ?? true) this.record(a, b, removed, repl)
    this.onSplice?.({ kind: "splice", bufferId: this.id, from: a, to: b, text: repl, seq: 0 }, opts)
    this.onTextChange?.({ start: a, end: b, text: repl })
    this._text = this._text.slice(0, a) + repl + this._text.slice(b)
    this._spliceLineStarts(a, b, removed, repl)
    this._point = clamp(this._point <= a ? this._point : this._point >= b ? this._point + repl.length - (b - a) : a, 0, this._text.length)
    this.adjustMark(a, b, repl.length)
    this.deactivateMark()
    if (markDirty) this.dirty = true
    return removed
  }

  setText(text: string, markDirty = true, snapshot = true): void {
    this._splice(0, this._text.length, text, { markDirty, snapshot })
  }

  /** Public mutation funnel for callers that need explicit snapshot control
   *  (shadow rebase applies authority ops with snapshot:false). Returns removed text. */
  splice(from: number, to: number, repl: string, opts?: { markDirty?: boolean; snapshot?: boolean }): string {
    return this._splice(from, to, repl, opts)
  }

  /** Append without snapshot/dirty — for *messages*, *compilation* streaming. */
  append(s: string): void {
    this._splice(this._text.length, this._text.length, s, { markDirty: false, snapshot: false })
  }

  insert(s: string): void {
    if (!s) return
    const at = this._point
    this._splice(at, at, s)
    this.point = at + s.length
  }

  deleteBackward(): void {
    if (this._point <= 0) return
    this._splice(this._point - 1, this._point, "")
  }

  deleteForward(): void {
    if (this._point >= this._text.length) return
    this._splice(this._point, this._point + 1, "")
  }

  deleteRange(start: number, end: number): string {
    const removed = this._splice(start, end, "")
    if (removed) this.point = clamp(Math.min(start, end), 0, this._text.length)
    return removed
  }

  get point(): number { return this._point }
  set point(n: number) { this._point = n; this.goalColumn = null }

  move(delta: number): void {
    this.point = clamp(this.point + delta, 0, this.text.length)
  }

  moveLine(delta: number): void {
    const cur = this.lineAt(this._point)
    const goal = this.goalColumn ?? this._point - this._lineStarts[cur]!
    const next = clamp(cur + delta, 0, this._lineStarts.length - 1)
    const [start, end] = this.lineBounds(next)
    this._point = start + Math.min(goal, end - start)
    this.goalColumn = goal
  }

  moveToLineStart(): void {
    const previousNewline = this.point <= 0 ? -1 : this.text.lastIndexOf("\n", this.point - 1)
    this.point = previousNewline + 1
  }

  moveToLineEnd(): void {
    const nextNewline = this.text.indexOf("\n", this.point)
    this.point = nextNewline === -1 ? this.text.length : nextNewline
  }

  moveToBufferStart(): void {
    this.point = 0
  }

  moveToBufferEnd(): void {
    this.point = this.text.length
  }

  moveWord(delta: number): void {
    const fwd = (this.locals.get("word-forward-regexp") as string | undefined) ?? "\\W*\\w+"
    const bwd = (this.locals.get("word-backward-regexp") as string | undefined) ?? "\\w+"
    if (delta > 0) {
      const match = new RegExp(fwd).exec(this.text.slice(this.point))
      this.point = match ? this.point + match.index + match[0].length : this.text.length
      return
    }

    const before = this.text.slice(0, this.point)
    const matches = [...before.matchAll(new RegExp(bwd, "g"))]
    const previous = matches.at(-1)
    this.point = previous?.index ?? 0
  }

  setMark(): void {
    this.mark = this.point
    this.markActive = true
  }

  deactivateMark(): void {
    if (!isTransientMarkModeEnabled()) return
    this.markActive = false
  }

  clearMark(): void {
    this.mark = null
    this.markActive = false
  }

  exchangePointAndMark(reactivate = true): boolean {
    if (this.mark == null) return false
    const previousMark = this.mark
    this.mark = this.point
    this.point = previousMark
    this.markActive = reactivate
    return true
  }

  /** Emacs `use-region-p`: active when mark differs from point and (if transient-mark-mode) mark is active. */
  useRegion(): boolean {
    if (this.mark == null || this.mark === this.point) return false
    return !isTransientMarkModeEnabled() || this.markActive
  }

  /** Emacs `delete-active-region`: delete the active region without pushing the kill ring. */
  deleteActiveRegion(): boolean {
    if (!this.useRegion()) return false
    const [start, end] = [this.mark!, this.point].sort((x, y) => x - y)
    this.deleteRange(start, end)
    return true
  }

  selectedText(): string {
    if (this.mark == null || this.mark === this.point) return ""
    const [a, b] = [this.mark, this.point].sort((x, y) => x - y)
    return this.text.slice(a, b)
  }

  selectedOrAll(): string {
    return this.selectedText() || this.text
  }

  async save(ctx: SaveContext = {}): Promise<void> {
    if (!this.path) throw new Error(`Buffer ${this.name} has no file path`)
    await ctx.runHook?.("before-save-hook", this)
    if (!ctx.force && !(await this.verifyVisitedFileModtime())) {
      const ok = await ctx.confirm?.(`${this.name} has changed on disk; save anyway?`)
      if (ok !== true) throw new Error(`File ${this.path} changed on disk since visited`)
    }
    if ((ctx.makeBackupFiles ?? true) && !this.backedUp && await fileExists(this.path)) {
      const backupPath = resolveBackupPath(this.path, ctx.backupDirectoryAlist)
      if (backupPath !== null) {
        const target = backupPath ?? this.path + "~"
        await mkdir(dirname(target), { recursive: true })
        await copyFile(this.path, target)
      }
      this.backedUp = true
    }
    await writeFileText(this.path, this.text)
    this.markSaved(await fileModtime(this.path))
    await ctx.runHook?.("after-save-hook", this)
  }

  /** Emacs verify-visited-file-modtime: false only when a visited file's disk mtime
   *  has moved past what we recorded. No path / never-read / deleted-on-disk → true. */
  async verifyVisitedFileModtime(): Promise<boolean> {
    if (!this.path || this.visitedFileModtime == null) return true
    const diskMtime = await fileModtime(this.path)
    return diskMtime == null || diskMtime <= this.visitedFileModtime
  }

  /** Re-read from disk. Shared body for revert-buffer, auto-revert, and the
   *  openFile revisit prompt; refreshes visitedFileModtime so a subsequent
   *  save() doesn't spuriously see a clash. Undo history is kept — the revert
   *  itself becomes an undoable step — and the saved-state baseline moves here. */
  async revert(): Promise<void> {
    if (!this.path) throw new Error(`Buffer ${this.name} is not visiting a file`)
    const text = await readFileText(this.path)
    this.setText(text, false)
    this.markSaved(await fileModtime(this.path))
  }

  /** Mark the current text as synchronized with its visited file. Remote file
   *  backends use this after their own transport-specific read/write path. */
  markSaved(visitedFileModtime?: number): void {
    this.visitedFileModtime = visitedFileModtime
    this.savedNode = this.undoCur
    this.dirty = false
  }

  /** Seq of the current undo-tree tip. Monotone over `record()`; root is 0. */
  get seq(): number { return this.undoCur.seq }

  /** Walk parent pointers, undoing, until the tip is at `seq`. The target must lie
   *  on the current node's ancestor chain (shadow rebase: baseSeq is the last sync point). */
  rewindTo(seq: number): void {
    while (this.undoCur.seq !== seq) {
      if (!this.undoCur.parent) throw new Error(`rewindTo(${seq}): not on ancestor chain (at root)`)
      if (this.undoCur.seq < seq) throw new Error(`rewindTo(${seq}): overshot to ${this.undoCur.seq}`)
      this.undo()
    }
  }

  undo(): void {
    const node = this.undoCur
    if (!node.parent) return
    for (let i = node.ops.length - 1; i >= 0; i--) {
      const op = node.ops[i]!
      this._splice(op.from, op.from + op.inserted.length, op.removed, { snapshot: false })
    }
    this.point = node.ops[0]!.point
    this.undoCur = node.parent
    this.dirty = this.undoCur !== this.savedNode
  }

  /** Fold the most recent mutation into the previous undo step. Call immediately
   *  after the second mutation. No-op while a shadow link is attached: unlinking a
   *  node whose splice already shipped breaks the pending↔undo-node 1:1 that the
   *  rebase rewind counts on, so over the wire each splice stays its own step. */
  amalgamateUndo(): void {
    if (this.link) return
    const p = this.undoCur.parent
    if (!p?.parent) return
    this.undoCur.ops = [...p.ops, ...this.undoCur.ops]
    this.undoCur.parent = p.parent
    p.parent.children[p.parent.children.indexOf(p)] = this.undoCur
  }

  redo(): void {
    const child = this.undoCur.children.at(-1)
    if (!child) return
    for (const op of child.ops) {
      this._splice(op.from, op.from + op.removed.length, op.inserted, { snapshot: false })
    }
    this.undoCur = child
    this.dirty = this.undoCur !== this.savedNode
  }

  replaceRange(start: number, end: number, replacement: string): void {
    this._splice(start, end, replacement)
    this.point = clamp(Math.min(start, end), 0, this._text.length) + replacement.length
  }

  lineBoundsAt(point = this.point): { start: number; end: number; text: string } {
    const start = point <= 0 ? 0 : this.text.lastIndexOf("\n", point - 1) + 1
    const newline = this.text.indexOf("\n", point)
    const end = newline === -1 ? this.text.length : newline
    return { start, end, text: this.text.slice(start, end) }
  }

  symbolBoundsAt(point = this.point): { start: number; end: number; text: string } {
    const isSymbol = (ch: string) => /[A-Za-z0-9_]/.test(ch)
    let start = clamp(point, 0, this.text.length)
    let end = start
    while (start > 0 && isSymbol(this.text[start - 1]!)) start--
    while (end < this.text.length && isSymbol(this.text[end]!)) end++
    return { start, end, text: this.text.slice(start, end) }
  }

  private adjustMark(from: number, to: number, inserted: number): void {
    if (this.mark == null) return
    if (this.mark > to) this.mark += inserted - (to - from)
    else if (this.mark > from) this.mark = from
    this.mark = clamp(this.mark, 0, this._text.length)
  }

  private assertWritable(markDirty: boolean): void {
    if (markDirty && this.readOnly) throw new Error(`Buffer ${this.name} is read-only`)
  }

  private record(from: number, to: number, removed: string, inserted: string): void {
    const node: UndoNode = { ops: [{ from, to, removed, inserted, point: this._point }], parent: this.undoCur, children: [], seq: ++this.nextSeq }
    this.undoCur.children.push(node)
    this.undoCur = node
  }
}

async function fileModtime(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return undefined
  }
}

export function inferMode(path: string): string {
  if (/\.(js|mjs|cjs|jsx)$/.test(path)) return "javascript"
  if (/\.(ts|mts|cts|tsx)$/.test(path)) return "typescript"
  if (/\.(html?|xhtml)$/.test(path)) return "html"
  if (/\.java$/.test(path)) return "java"
  if (/\.json$/.test(path)) return "json"
  if (/\.(c|h)$/.test(path)) return "c"
  if (/\.ya?ml$/.test(path)) return "yaml"
  if (/README\.md$/i.test(path)) return "gfm"
  if (/\.(?:md|markdown|mkd|mdown|mkdn|mdwn)$/i.test(path)) return "markdown"
  if (/\.py$/.test(path)) return "python"
  if (/\.rs$/.test(path)) return "rust"
  if (/\.go$/.test(path)) return "go"
  if (/\.proto$/.test(path)) return "protobuf"
  if (/\.http$/.test(path)) return "restclient"
  if (/\.tf$/.test(path)) return "terraform"
  if (/\.(hbs|handlebars)$/.test(path)) return "handlebars"
  if (/\.glsl$/.test(path)) return "glsl"
  if (/(^|\/)Jenkinsfile$/.test(path)) return "jenkinsfile"
  if (/\.exs?$/.test(path)) return "elixir"
  if (/\.prisma$/.test(path)) return "prisma"
  return "text"
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function scanLineStarts(text: string): number[] {
  const ls = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) ls.push(i + 1)
  return ls
}

/** Index of first element strictly > x in a sorted array (== upper_bound). */
function bsearchGT(a: readonly number[], x: number): number {
  let lo = 0, hi = a.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (a[mid]! <= x) lo = mid + 1; else hi = mid
  }
  return lo
}
