import { dirname, basename } from "node:path"

export type BufferKind = "file" | "directory" | "scratch" | "messages" | "inspector" | "minibuffer" | "grep"

export class BufferModel {
  readonly id: string
  name: string
  path?: string
  kind: BufferKind
  text: string
  point = 0
  mark: number | null = null
  markActive = false
  dirty = false
  readOnly = false
  mode = "text"
  onTextChange?: (event: { start: number; end: number; text: string }) => void
  private undoStack: string[] = []
  private redoStack: string[] = []

  constructor(args: { id?: string; name: string; text?: string; path?: string; kind?: BufferKind; mode?: string }) {
    this.id = args.id ?? crypto.randomUUID()
    this.name = args.name
    this.text = args.text ?? ""
    this.path = args.path
    this.kind = args.kind ?? (args.path ? "file" : "scratch")
    this.mode = args.mode ?? inferMode(args.path ?? args.name)
  }

  static async fromFile(path: string): Promise<BufferModel> {
    const file = Bun.file(path)
    const text = await file.exists() ? await file.text() : ""
    return new BufferModel({ name: basename(path), path, text, kind: "file", mode: inferMode(path) })
  }

  directory(): string | undefined {
    return this.path ? dirname(this.path) : undefined
  }

  lineCol(): { line: number; col: number } {
    const before = this.text.slice(0, this.point)
    const lines = before.split("\n")
    return { line: lines.length, col: lines.at(-1)!.length + 1 }
  }

  setText(text: string, markDirty = true): void {
    this.assertWritable(markDirty)
    this.snapshot()
    const previous = this.text
    if (previous !== text) this.onTextChange?.({ start: 0, end: previous.length, text })
    this.text = text
    this.point = Math.min(this.point, this.text.length)
    this.dirty ||= markDirty
    this.deactivateMark()
  }

  insert(s: string): void {
    if (!s) return
    this.deactivateMark()
    this.assertWritable(true)
    this.snapshot()
    const start = this.point
    this.onTextChange?.({ start, end: start, text: s })
    this.text = this.text.slice(0, this.point) + s + this.text.slice(this.point)
    this.point += s.length
    this.dirty = true
  }

  deleteBackward(): void {
    if (this.point <= 0) return
    this.deactivateMark()
    this.assertWritable(true)
    this.snapshot()
    const end = this.point
    const start = this.point - 1
    this.onTextChange?.({ start, end, text: "" })
    this.text = this.text.slice(0, this.point - 1) + this.text.slice(this.point)
    this.point--
    this.dirty = true
  }

  deleteForward(): void {
    if (this.point >= this.text.length) return
    this.deactivateMark()
    this.assertWritable(true)
    this.snapshot()
    const start = this.point
    const end = this.point + 1
    this.onTextChange?.({ start, end, text: "" })
    this.text = this.text.slice(0, this.point) + this.text.slice(this.point + 1)
    this.dirty = true
  }

  deleteRange(start: number, end: number): string {
    const from = clamp(Math.min(start, end), 0, this.text.length)
    const to = clamp(Math.max(start, end), 0, this.text.length)
    if (from === to) return ""
    this.deactivateMark()
    this.assertWritable(true)
    this.snapshot()
    const removed = this.text.slice(from, to)
    this.text = this.text.slice(0, from) + this.text.slice(to)
    this.point = from
    this.dirty = true
    return removed
  }

  move(delta: number): void {
    this.deactivateMark()
    this.point = clamp(this.point + delta, 0, this.text.length)
  }

  moveLine(delta: number): void {
    this.deactivateMark()
    const lines = this.text.split("\n")
    const { line, col } = this.lineCol()
    const nextLine = clamp(line - 1 + delta, 0, lines.length - 1)
    let offset = 0
    for (let i = 0; i < nextLine; i++) offset += lines[i]!.length + 1
    this.point = clamp(offset + Math.min(col - 1, lines[nextLine]!.length), 0, this.text.length)
  }

  moveToLineStart(): void {
    this.deactivateMark()
    const previousNewline = this.point <= 0 ? -1 : this.text.lastIndexOf("\n", this.point - 1)
    this.point = previousNewline + 1
  }

  moveToLineEnd(): void {
    this.deactivateMark()
    const nextNewline = this.text.indexOf("\n", this.point)
    this.point = nextNewline === -1 ? this.text.length : nextNewline
  }

  moveToBufferStart(): void {
    this.deactivateMark()
    this.point = 0
  }

  moveToBufferEnd(): void {
    this.deactivateMark()
    this.point = this.text.length
  }

  moveWord(delta: number): void {
    this.deactivateMark()
    if (delta > 0) {
      const match = /\W*\w+/.exec(this.text.slice(this.point))
      this.point = match ? this.point + match.index + match[0].length : this.text.length
      return
    }

    const before = this.text.slice(0, this.point)
    const matches = [...before.matchAll(/\w+/g)]
    const previous = matches.at(-1)
    this.point = previous?.index ?? 0
  }

  setMark(): void {
    this.mark = this.point
    this.markActive = true
  }

  deactivateMark(): void {
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

  selectedText(): string {
    if (this.mark == null || this.mark === this.point) return ""
    const [a, b] = [this.mark, this.point].sort((x, y) => x - y)
    return this.text.slice(a, b)
  }

  selectedOrAll(): string {
    return this.selectedText() || this.text
  }

  async save(): Promise<void> {
    if (!this.path) throw new Error(`Buffer ${this.name} has no file path`)
    await Bun.write(this.path, this.text)
    this.dirty = false
  }

  undo(): void {
    const previous = this.undoStack.pop()
    if (previous == null) return
    this.redoStack.push(this.text)
    this.text = previous
    this.point = Math.min(this.point, this.text.length)
    this.dirty = true
  }

  redo(): void {
    const next = this.redoStack.pop()
    if (next == null) return
    this.undoStack.push(this.text)
    this.text = next
    this.point = Math.min(this.point, this.text.length)
    this.dirty = true
  }

  replaceRange(start: number, end: number, replacement: string): void {
    const from = clamp(Math.min(start, end), 0, this.text.length)
    const to = clamp(Math.max(start, end), 0, this.text.length)
    this.deactivateMark()
    this.assertWritable(true)
    this.snapshot()
    this.onTextChange?.({ start: from, end: to, text: replacement })
    this.text = this.text.slice(0, from) + replacement + this.text.slice(to)
    this.point = from + replacement.length
    this.dirty = true
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

  private assertWritable(markDirty: boolean): void {
    if (markDirty && this.readOnly) throw new Error(`Buffer ${this.name} is read-only`)
  }

  private snapshot(): void {
    this.undoStack.push(this.text)
    if (this.undoStack.length > 200) this.undoStack.shift()
    this.redoStack = []
  }
}

export function inferMode(path: string): string {
  if (/\.(js|mjs|cjs|jsx)$/.test(path)) return "javascript"
  if (/\.(ts|mts|cts|tsx)$/.test(path)) return "typescript"
  if (/\.(html?|xhtml)$/.test(path)) return "html"
  if (/\.java$/.test(path)) return "java"
  if (/\.json$/.test(path)) return "json"
  if (/\.ya?ml$/.test(path)) return "yaml"
  if (/\.mdx?$/.test(path)) return "markdown"
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
