import { dirname, basename } from "node:path"
import { cp, cwd, fileExists, mkdir, readFileText, stat, writeFileText } from "../platform/runtime"
import { resolveBackupPath, type BackupDirectoryAlist } from "./backup-path"
import { isTransientMarkModeEnabled } from "./transient-mark"
import type { ShadowLink } from "../shadow/link"
import type { Splice } from "../shadow/ops"

export type BufferKind = "file" | "directory" | "scratch" | "messages" | "inspector" | "minibuffer" | "grep"

/** GNU Emacs' root default major mode (`(default-value 'major-mode)`). A buffer
 *  gets it when no rule selects another mode. It has no keymap, no font-lock
 *  and no comment syntax, and no other mode derives from it. */
export const FUNDAMENTAL_MODE = "fundamental-mode"

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

export type UndoOp = { from: number; to: number; removed: string; inserted: string; point: number }
export type BufferRestriction = { start: number; end: number }
type Op = UndoOp
type UndoNode = {
  ops: Op[]
  parent: UndoNode | null
  children: UndoNode[]
  seq: number
  at: number
  activeChild?: number
}

export type SerializedUndoTree = {
  version: 1
  textHash: string
  nodes: Array<{ id: number; parentId: number | null; ops: UndoOp[]; at: number; activeChild?: number }>
  currentId: number
  nextSeq: number
}

/** Buffer-local `revert-buffer-function`: a command name run by `revert-buffer`. */
export const REVERT_BUFFER_FUNCTION_KEY = "revert-buffer-function"

export type UndoTreeNodeView = {
  id: number
  at: number
  saved: boolean
  current: boolean
  activeChild: number
  children: UndoTreeNodeView[]
}

export class BufferModel {
  readonly id: string
  private _name: string
  private _path?: string
  private _kind: BufferKind
  private _text: string
  /** Offsets of line starts (lineStarts[0] === 0). Incrementally maintained in `_splice`. */
  private _lineStarts!: number[]
  private _point = 0
  goalColumn: number | null = null
  mark: number | null = null
  markActive = false
  dirty = false
  private _readOnly = false
  private _mode = FUNDAMENTAL_MODE
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
  private undoRoot: UndoNode = { ops: [], parent: null, children: [], seq: 0, at: Date.now() }
  private undoCur: UndoNode = this.undoRoot
  /** Tree node at which text matches disk. */
  private savedNode: UndoNode = this.undoRoot
  private backedUp = false
  private _restriction: BufferRestriction | null = null
  /** Widget-style editable regions (Custom buffers). When set, user edits are
   *  confined to these ranges, as Emacs' `text-read-only` property does. */
  private _editableFields: Array<{ start: number; end: number }> | null = null

  constructor(args: { id?: string; name: string; text?: string; path?: string; kind?: BufferKind; mode?: string }) {
    this.id = args.id ?? crypto.randomUUID()
    this._name = args.name
    this._text = args.text ?? ""
    this._lineStarts = scanLineStarts(this._text)
    this._path = args.path
    this._kind = args.kind ?? (args.path ? "file" : "scratch")
    this._mode = args.mode ?? inferMode(args.path ?? args.name, this._text)
    this.syncEmacsVariables()
  }

  get name(): string { return this._name }
  set name(value: string) { this._name = value }

  get path(): string | undefined { return this._path }
  set path(value: string | undefined) {
    this._path = value
    this.syncFileVariables()
  }

  get kind(): BufferKind { return this._kind }
  set kind(value: BufferKind) {
    this._kind = value
    this.syncFileVariables()
  }

  get readOnly(): boolean { return this._readOnly }
  set readOnly(value: boolean) {
    this._readOnly = value
    this.locals.set("buffer-read-only", value)
  }

  /** Ranges the user may edit; null means the whole buffer (the normal case).
   *  The array is owned by the buffer: entries are moved in place as text
   *  changes, so a caller holding the same objects sees the live bounds. */
  get editableFields(): ReadonlyArray<{ start: number; end: number }> | null { return this._editableFields }
  setEditableFields(fields: Array<{ start: number; end: number }> | null): void {
    this._editableFields = fields
  }

  get mode(): string { return this._mode }
  set mode(value: string) {
    this._mode = value
    this.locals.set("major-mode", value)
    this.locals.set("mode-name", value)
  }

  /** Keep Emacs' automatically buffer-local variables backed by canonical
   *  BufferModel state. Plugins can consequently use the same `locals` path
   *  for built-in variables and their own buffer-local variables. */
  private syncEmacsVariables(): void {
    this.syncFileVariables()
    this.locals.set("major-mode", this._mode)
    this.locals.set("mode-name", this._mode)
    this.locals.set("buffer-read-only", this._readOnly)
  }

  private syncFileVariables(): void {
    this.locals.set("buffer-file-name", this._kind === "file" ? this._path ?? null : null)
    const directory = this.directory() ?? cwd()
    this.locals.set("default-directory", directory.endsWith("/") ? directory : `${directory}/`)
  }

  static async fromFile(path: string): Promise<BufferModel> {
    const exists = await fileExists(path)
    const text = exists ? await readFileText(path) : ""
    const buf = new BufferModel({ name: basename(path), path, text, kind: "file", mode: inferMode(path, text) })
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
  get pointMin(): number { return this._restriction?.start ?? 0 }
  get pointMax(): number { return this._restriction?.end ?? this._text.length }
  get isNarrowed(): boolean { return this.pointMin !== 0 || this.pointMax !== this._text.length }
  get restriction(): BufferRestriction | null {
    return this.isNarrowed ? { start: this.pointMin, end: this.pointMax } : null
  }

  narrowToRegion(start: number, end: number): void {
    const len = this._text.length
    const a = clamp(Math.min(start, end), 0, len)
    const b = clamp(Math.max(start, end), 0, len)
    this._restriction = a === 0 && b === len ? null : { start: a, end: b }
    this._point = this.clampPoint(this._point)
    if (this.mark != null) this.mark = this.clampPoint(this.mark)
  }

  widen(): void {
    this._restriction = null
    this._point = this.clampPoint(this._point)
    if (this.mark != null) this.mark = this.clampPoint(this.mark)
  }

  /** 0-indexed line containing `offset`. */
  lineAt(offset: number): number {
    offset = this.clampPoint(offset)
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
    const rawStart = ls[i]!
    const rawEnd = i + 1 < ls.length ? ls[i + 1]! - 1 : this._text.length
    const start = clamp(rawStart, this.pointMin, this.pointMax)
    const end = clamp(rawEnd, this.pointMin, this.pointMax)
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
    if ((opts.snapshot ?? true) && markDirty) this.assertInsideRestriction(a, b)
    if ((opts.snapshot ?? true) && markDirty) this.assertInsideEditableField(a, b)
    const removed = this._text.slice(a, b)
    if (opts.snapshot ?? true) this.record(a, b, removed, repl)
    this.onSplice?.({ kind: "splice", bufferId: this.id, from: a, to: b, text: repl, seq: 0 }, opts)
    this.onTextChange?.({ start: a, end: b, text: repl })
    this._text = this._text.slice(0, a) + repl + this._text.slice(b)
    this._spliceLineStarts(a, b, removed, repl)
    this.adjustRestriction(a, b, repl.length)
    this.adjustEditableFields(a, b, repl.length)
    this._point = this.clampPoint(this._point <= a ? this._point : this._point >= b ? this._point + repl.length - (b - a) : a)
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
    if (this._point <= this.pointMin) return
    this._splice(this._point - 1, this._point, "")
  }

  deleteForward(): void {
    if (this._point >= this.pointMax) return
    this._splice(this._point, this._point + 1, "")
  }

  deleteRange(start: number, end: number): string {
    const removed = this._splice(start, end, "")
    if (removed) this.point = clamp(Math.min(start, end), 0, this._text.length)
    return removed
  }

  get point(): number { return this._point }
  set point(n: number) { this._point = this.clampPoint(n); this.goalColumn = null }

  move(delta: number): void {
    this.point = this.point + delta
  }

  moveLine(delta: number): void {
    const cur = this.lineAt(this._point)
    const goal = this.goalColumn ?? this._point - this._lineStarts[cur]!
    const next = clamp(cur + delta, 0, this._lineStarts.length - 1)
    const [start, end] = this.lineBounds(next)
    this._point = this.clampPoint(start + Math.min(goal, Math.max(0, end - start)))
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
    this.point = this.pointMin
  }

  moveToBufferEnd(): void {
    this.point = this.pointMax
  }

  moveWord(delta: number): void {
    const fwd = (this.locals.get("word-forward-regexp") as string | undefined) ?? "\\W*\\w+"
    const bwd = (this.locals.get("word-backward-regexp") as string | undefined) ?? "\\w+"
    if (delta > 0) {
      const match = new RegExp(fwd).exec(this._text.slice(this.point, this.pointMax))
      this.point = match ? this.point + match.index + match[0].length : this.pointMax
      return
    }

    const before = this._text.slice(this.pointMin, this.point)
    const matches = [...before.matchAll(new RegExp(bwd, "g"))]
    const previous = matches.at(-1)
    this.point = previous?.index != null ? this.pointMin + previous.index : this.pointMin
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
    const [rawA, rawB] = [this.mark, this.point].sort((x, y) => x - y)
    const a = clamp(rawA, this.pointMin, this.pointMax)
    const b = clamp(rawB, this.pointMin, this.pointMax)
    return this.text.slice(a, b)
  }

  selectedOrAll(): string {
    return this.selectedText() || this.text.slice(this.pointMin, this.pointMax)
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
        await cp(this.path, target, { force: true })
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

  undoTreeSnapshot(): { root: UndoTreeNodeView; current: UndoTreeNodeView } {
    let current!: UndoTreeNodeView
    const visit = (node: UndoNode): UndoTreeNodeView => {
      const view: UndoTreeNodeView = {
        id: node.seq,
        at: node.at,
        saved: node === this.savedNode,
        current: node === this.undoCur,
        activeChild: node.activeChild ?? node.children.length - 1,
        children: node.children.map(visit),
      }
      if (node === this.undoCur) current = view
      return view
    }
    const root = visit(this.undoRoot)
    return { root, current }
  }

  undoTreeSerialize(): SerializedUndoTree {
    const nodes: SerializedUndoTree["nodes"] = []
    const visit = (node: UndoNode): void => {
      nodes.push({
        id: node.seq,
        parentId: node.parent?.seq ?? null,
        ops: node.ops.map(op => ({ ...op })),
        at: node.at,
        ...(node.activeChild === undefined ? {} : { activeChild: node.activeChild }),
      })
      for (const child of node.children) visit(child)
    }
    visit(this.undoRoot)
    return {
      version: 1,
      textHash: textHash(this._text),
      nodes,
      currentId: this.undoCur.seq,
      nextSeq: this.nextSeq,
    }
  }

  undoTreeRestore(data: SerializedUndoTree): boolean {
    if (this.link || !isSerializedUndoTree(data)) return false
    if (data.version !== 1 || data.textHash !== textHash(this._text)) return false

    const roots = data.nodes.filter(node => node.parentId === null)
    if (roots.length !== 1 || roots[0]!.id !== 0) return false
    if (data.nextSeq < Math.max(...data.nodes.map(node => node.id))) return false

    const byId = new Map<number, UndoNode>()
    for (const raw of data.nodes) {
      if (byId.has(raw.id)) return false
      byId.set(raw.id, {
        ops: raw.ops.map(op => ({ ...op })),
        parent: null,
        children: [],
        seq: raw.id,
        at: raw.at,
        ...(raw.activeChild === undefined ? {} : { activeChild: raw.activeChild }),
      })
    }

    for (const raw of data.nodes) {
      const node = byId.get(raw.id)!
      if (raw.parentId === null) continue
      const parent = byId.get(raw.parentId)
      if (!parent) return false
      node.parent = parent
      parent.children.push(node)
    }

    const root = byId.get(0)
    const current = byId.get(data.currentId)
    if (!root || !current) return false
    for (const node of byId.values()) {
      if (node.activeChild === undefined) continue
      if (node.children.length === 0 ? node.activeChild !== -1 : node.activeChild < 0 || node.activeChild >= node.children.length) return false
    }
    const reachable = new Set<UndoNode>()
    const stack = [root]
    while (stack.length) {
      const node = stack.pop()!
      if (reachable.has(node)) return false
      reachable.add(node)
      stack.push(...node.children)
    }
    if (reachable.size !== byId.size) return false

    this.undoRoot = root
    this.undoCur = current
    this.nextSeq = data.nextSeq
    this.savedNode = current
    this.dirty = false
    return true
  }

  undoSetBranch(nodeId: number, childIndex: number): boolean {
    const node = this.findUndoNode(nodeId)
    if (!node) return false
    node.activeChild = node.children.length ? clamp(Math.trunc(childIndex), 0, node.children.length - 1) : -1
    return true
  }

  undoBranchCount(): number {
    return this.undoCur.children.length
  }

  undoToNode(nodeId: number): boolean {
    const target = this.findUndoNode(nodeId)
    if (!target) return false
    if (target === this.undoCur) return true

    const currentPath = this.pathToRoot(this.undoCur)
    const targetPath = this.pathToRoot(target)
    let currentIndex = currentPath.length - 1
    let targetIndex = targetPath.length - 1
    while (currentIndex >= 0 && targetIndex >= 0 && currentPath[currentIndex] === targetPath[targetIndex]) {
      currentIndex--
      targetIndex--
    }

    for (let i = 0; i <= currentIndex; i++) this.undo()
    for (let i = targetIndex; i >= 0; i--) {
      const child = targetPath[i]!
      const parent = child.parent!
      parent.activeChild = parent.children.indexOf(child)
      this.redo()
    }
    return true
  }

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
    this.undoCur.at = Math.max(this.undoCur.at, p.at)
    this.undoCur.parent = p.parent
    p.parent.children[p.parent.children.indexOf(p)] = this.undoCur
  }

  redo(): void {
    const child = this.undoCur.children[this.undoCur.activeChild ?? this.undoCur.children.length - 1]
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
    point = this.clampPoint(point)
    const start = Math.max(this.pointMin, point <= 0 ? 0 : this.text.lastIndexOf("\n", point - 1) + 1)
    const newline = this.text.indexOf("\n", point)
    const end = Math.min(this.pointMax, newline === -1 ? this.text.length : newline)
    return { start, end, text: this.text.slice(start, end) }
  }

  symbolBoundsAt(point = this.point): { start: number; end: number; text: string } {
    const isSymbol = (ch: string) => /[A-Za-z0-9_]/.test(ch)
    let start = this.clampPoint(point)
    let end = start
    while (start > this.pointMin && isSymbol(this.text[start - 1]!)) start--
    while (end < this.pointMax && isSymbol(this.text[end]!)) end++
    return { start, end, text: this.text.slice(start, end) }
  }

  private adjustMark(from: number, to: number, inserted: number): void {
    if (this.mark == null) return
    if (this.mark > to) this.mark += inserted - (to - from)
    else if (this.mark > from) this.mark = from
    this.mark = this.clampPoint(this.mark)
  }

  private assertWritable(markDirty: boolean): void {
    if (markDirty && this.readOnly) throw new Error(`Buffer ${this.name} is read-only`)
  }

  private assertInsideEditableField(from: number, to: number): void {
    const fields = this._editableFields
    if (!fields) return
    if (fields.some(field => from >= field.start && to <= field.end)) return
    throw new Error("Attempt to change text outside editable field")
  }

  /** Grow/shrink the field the edit landed in, and shift every later field. */
  private adjustEditableFields(from: number, to: number, inserted: number): void {
    if (!this._editableFields) return
    const delta = inserted - (to - from)
    if (!delta) return
    for (const field of this._editableFields) {
      if (field.end < from) continue
      if (field.start > to) {
        field.start += delta
        field.end += delta
        continue
      }
      field.end = Math.max(field.start, field.end + delta)
    }
  }

  private assertInsideRestriction(from: number, to: number): void {
    if (!this.isNarrowed) return
    if (from < this.pointMin || to > this.pointMax) throw new Error(`Cannot edit outside narrowed region in ${this.name}`)
  }

  private clampPoint(n: number): number {
    return clamp(Math.trunc(Number.isFinite(n) ? n : this.pointMin), this.pointMin, this.pointMax)
  }

  private adjustRestriction(from: number, to: number, inserted: number): void {
    if (!this._restriction) return
    const replEnd = from + inserted
    const start = transformRestrictionStart(this._restriction.start, from, to, inserted)
    const end = transformRestrictionEnd(this._restriction.end, from, to, replEnd, inserted)
    const len = this._text.length
    const a = clamp(Math.min(start, end), 0, len)
    const b = clamp(Math.max(start, end), 0, len)
    this._restriction = a === 0 && b === len ? null : { start: a, end: b }
  }

  private record(from: number, to: number, removed: string, inserted: string): void {
    const node: UndoNode = {
      ops: [{ from, to, removed, inserted, point: this._point }],
      parent: this.undoCur,
      children: [],
      seq: ++this.nextSeq,
      at: Date.now(),
    }
    this.undoCur.children.push(node)
    this.undoCur.activeChild = this.undoCur.children.length - 1
    this.undoCur = node
  }

  private findUndoNode(seq: number): UndoNode | undefined {
    const stack = [this.undoRoot]
    while (stack.length) {
      const node = stack.pop()!
      if (node.seq === seq) return node
      stack.push(...node.children)
    }
    return undefined
  }

  private pathToRoot(node: UndoNode): UndoNode[] {
    const path: UndoNode[] = []
    for (let n: UndoNode | null = node; n; n = n.parent) path.push(n)
    return path
  }
}

export function withSavedRestriction<T>(buffer: BufferModel, fn: () => T): T {
  const saved = buffer.restriction
  const restore = () => {
    if (saved) buffer.narrowToRegion(saved.start, saved.end)
    else buffer.widen()
  }
  try {
    const result = fn()
    if (isPromiseLike(result)) {
      return result.finally(restore) as T
    }
    restore()
    return result
  } catch (error) {
    restore()
    throw error
  }
}

async function fileModtime(path: string): Promise<number | undefined> {
  return (await stat(path))?.mtime
}

export function inferMode(path: string, text = ""): string {
  if (/\.(js|mjs|cjs|jsx)$/.test(path)) return "javascript"
  if (/\.(ts|mts|cts|tsx)$/.test(path)) return "typescript"
  if (/\.html?$/.test(path)) return "html"
  if (/\.java$/.test(path)) return "java"
  if (/\.json$/.test(path)) return "json"
  if (/\.c$/.test(path)) return "c"
  if (/\.h$/.test(path)) return cOrCpp(text)
  if (/\.ya?ml$/.test(path)) return "yaml"
  if (/README\.md$/i.test(path)) return "gfm"
  if (/\.(?:md|markdown|mkd|mdown|mkdn|mdwn)$/i.test(path)) return "markdown"
  if (/\.py$/.test(path)) return "python"
  if (/\.el$/.test(path)) return "emacs-lisp-mode"
  if (/\.rs$/.test(path)) return "rust"
  if (/\.go$/.test(path)) return "go"
  if (/\.(diff|patch)$/i.test(path) || /(^|\/)(COMMIT_EDITMSG|MERGE_MSG)$/.test(path) && /^diff --git /m.test(text)) return "diff-mode"
  if (/\.proto$/.test(path)) return "protobuf"
  if (/\.http$/.test(path)) return "restclient"
  if (/\.tf$/.test(path)) return "terraform"
  if (/\.(hbs|handlebars)$/.test(path)) return "handlebars"
  if (/\.glsl$/.test(path)) return "glsl"
  if (/\.(mmd|mermaid)$/.test(path)) return "mermaid"
  if (/(^|\/)Jenkinsfile$/.test(path)) return "jenkinsfile"
  if (/\.exs?$/.test(path)) return "elixir"
  if (/\.prisma$/.test(path)) return "prisma"
  if (/\.css$/.test(path)) return "css-mode"
  if (/\.scss$/.test(path)) return "scss-mode"
  if (/\.sass$/.test(path)) return "sass-mode"
  if (/\.toml$/.test(path)) return "toml-mode"
  if (/(^|\/)(?:GNU|BSD)?[Mm]akefile$/.test(path) || /\.(mk|mak)$/.test(path)) return "makefile-mode"
  if (/(^|\/)Dockerfile(?:\.[\w.-]+)?$/.test(path) || /\.dockerfile$/.test(path)) return "dockerfile-mode"
  if (/\.(cc|cpp|cxx|hh|hpp|hxx|c\+\+|ipp)$/.test(path)) return "c++-mode"
  if (/\.(lisp|lsp|cl|asd)$/.test(path)) return "lisp-mode"
  if (/\.(scm|ss|sld)$/.test(path)) return "scheme-mode"
  if (/\.(xml|svg|xhtml|plist|rss|xsl|xsd|wsdl)$/i.test(path)) return "xml-mode"
  if (/\.rst$/.test(path)) return "rst-mode"
  if (/\.(tex|ltx)$/.test(path)) return "latex-mode"
  if (/\.(sty|cls)$/.test(path)) return "tex-mode"
  if (/\.bib$/.test(path)) return "bibtex-mode"
  if (/(^|\/)CMakeLists\.txt$/.test(path) || /\.cmake$/.test(path)) return "cmake-mode"
  if (/(^|\/)go\.(mod|work)$/.test(path)) return "go-mod-mode"
  if (/(^|\/)go\.sum$/.test(path)) return "go-sum-mode"
  if (/(^|\/)ChangeLog(\.\d+)?$/.test(path)) return "change-log-mode"
  if (/(^|\/)(COMMIT_EDITMSG|MERGE_MSG|TAG_EDITMSG|NOTES_EDITMSG)$/.test(path)) return "log-edit-mode"
  if (/\.reg$/i.test(path)) return "conf-windows-mode"
  // GNU Emacs routes these through `conf-mode-maybe`, which picks a sub-mode
  // from the buffer contents (see `conf--guess-mode`). Matches Emacs'
  // "[/.]c\(on\)?f\(i?g\)?\(\.[a-zA-Z0-9._-]+\)?\'" plus the classic names.
  if (/[/.]c(?:on)?f(?:i?g)?(?:\.[a-zA-Z0-9._-]+)?$/.test(path)
    || /\.(ini|properties|service|desktop|editorconfig)$/i.test(path)
    || /(^|\/)\.env(?:\.[\w.-]+)?$/.test(path)
    || /(^|\/)\.(gitconfig|gitattributes|gitmodules|npmrc|hgrc)$/.test(path)) return guessConfMode(text)
  if (isShellScriptPath(path) || isShellShebang(text)) return "sh-mode"
  // GNU Emacs routes only these suffixes to `text-mode` through
  // `auto-mode-alist`; every other unmatched file stays in `fundamental-mode`.
  if (/\.(te?xt|article|letter)$/i.test(path)) return "text"
  return FUNDAMENTAL_MODE
}

/**
 * Port of GNU Emacs' `conf--guess-mode`: classify a conf file by counting the
 * shape of its lines. With no contents to judge (e.g. `inferMode(path)` during
 * a lookup) fall back to the generic parent mode.
 */
function guessConfMode(text: string): string {
  if (!text.trim()) return "conf-mode"
  let unix = 0, win = 0, equal = 0, colon = 0, space = 0, jp = 0
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^[ \t\f]+/, "")
    const assignment = /^[^ \t=:]+(?:  ?[^ \t=:]+)*[ \t]*[=:]/.exec(line)
    if (line.startsWith("#")) unix++
    else if (line.startsWith(";")) win++
    else if (line.startsWith("[") || line === "" || line.startsWith("}")) continue
    else if (assignment) {
      if (assignment[0].endsWith("=")) equal++
      else colon++
    } else if (/^\/[/*]/.test(line)) jp++
    else if (line.includes("{")) continue
    else space++
  }
  if (jp > Math.max(unix, win, 3)) return "conf-javaprop-mode"
  if (colon > Math.max(equal, space)) return "conf-colon-mode"
  if (space > Math.max(equal, colon)) return "conf-space-mode"
  if (win > unix) return "conf-windows-mode"
  return "conf-unix-mode"
}

function cOrCpp(text: string): "c" | "c++-mode" {
  const sample = text.slice(0, 2048)
  // C++ indicators: class/namespace declarations, template< or template <,
  // scope resolution (::/std::), extern "C++", common C++ library includes,
  // and access labels (public:/private:/protected:).
  return /\bclass\s+|\bnamespace\s+|\btemplate\s*<|::|\bstd::|\bextern\s+"C\+\+"|^\s*#\s*include\s*<(?:algorithm|array|bitset|chrono|deque|exception|filesystem|forward_list|fstream|functional|future|initializer_list|iomanip|ios|iosfwd|iostream|istream|iterator|limits|list|map|memory|mutex|new|numeric|ostream|queue|random|regex|set|sstream|stack|stdexcept|streambuf|string|string_view|thread|tuple|type_traits|typeindex|typeinfo|unordered_map|unordered_set|utility|valarray|variant|vector)>|^\s*(?:public|private|protected)\s*:/m.test(sample)
    ? "c++-mode"
    : "c"
}

function isShellScriptPath(path: string): boolean {
  return /\.(?:ba|z|k)?sh$/i.test(path)
    || /(^|\/)\.(?:bashrc|bash_profile|bash_login|bash_logout|profile|zshrc|zprofile|zlogin|zlogout|zshenv|kshrc)$/.test(path)
}

function isShellShebang(text: string): boolean {
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? undefined : text.indexOf("\n"))
  return /^#!\s*(?:\/usr\/bin\/env\s+(?:-\S+\s+)*|\/(?:usr\/)?bin\/)(?:ba|z|k)?sh(?:\s|$)/.test(firstLine)
}

function textHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

function isSerializedUndoTree(data: unknown): data is SerializedUndoTree {
  if (!data || typeof data !== "object") return false
  const t = data as SerializedUndoTree
  if (t.version !== 1 || typeof t.textHash !== "string" || !Array.isArray(t.nodes)) return false
  if (!isNonnegativeInteger(t.currentId) || !isNonnegativeInteger(t.nextSeq)) return false
  for (const node of t.nodes) {
    if (!node || typeof node !== "object") return false
    const n = node as SerializedUndoTree["nodes"][number]
    if (!isNonnegativeInteger(n.id) || (n.parentId !== null && !isNonnegativeInteger(n.parentId))) return false
    if (!Array.isArray(n.ops) || typeof n.at !== "number") return false
    if (n.activeChild !== undefined && !Number.isInteger(n.activeChild)) return false
    for (const op of n.ops) {
      if (!op || typeof op !== "object") return false
      const o = op as UndoOp
      if (![o.from, o.to, o.point].every(isNonnegativeInteger)) return false
      if (typeof o.removed !== "string" || typeof o.inserted !== "string") return false
    }
  }
  return true
}

function isNonnegativeInteger(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function transformRestrictionStart(point: number, from: number, to: number, inserted: number): number {
  if (point <= from) return point
  if (point >= to) return point + inserted - (to - from)
  return from
}

function transformRestrictionEnd(point: number, from: number, to: number, replEnd: number, inserted: number): number {
  if (point < from) return point
  if (point >= to) return point + inserted - (to - from)
  return replEnd
}

function isPromiseLike<T>(value: T): value is T & { finally(onfinally?: () => void): PromiseLike<unknown> } {
  return value != null && typeof value === "object" && "finally" in value && typeof value.finally === "function"
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
