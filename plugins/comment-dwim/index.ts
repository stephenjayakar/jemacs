import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { BufferModel } from "../../src/kernel/buffer"
import { modeFeature } from "../../src/modes/mode"
import { defcustom, getCustom } from "../../src/runtime/custom"

defcustom("comment-column", "number", 32, "Column to indent right-margin comments to.")

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function useRegion(buffer: BufferModel): boolean {
  return buffer.markActive && buffer.mark != null && buffer.mark !== buffer.point
}

function lineSpan(buffer: BufferModel, beg: number, end: number): { start: number; end: number } {
  const lo = Math.min(beg, end)
  let hi = Math.max(beg, end)
  const start = buffer.lineBoundsAt(lo).start
  // A region ending at column 0 of a line excludes that line, matching Emacs.
  if (hi > start && buffer.lineBoundsAt(hi).start === hi) hi--
  return { start, end: buffer.lineBoundsAt(hi).end }
}

function commentOrUncommentRegion(buffer: BufferModel, beg: number, end: number, starter: string): void {
  const span = lineSpan(buffer, beg, end)
  const block = buffer.text.slice(span.start, span.end)
  const lines = block.split("\n")
  const re = new RegExp(`^(\\s*)${escapeRegex(starter)} ?`)
  const nonBlank = lines.filter(l => l.trim() !== "")
  const allCommented = nonBlank.length > 0 && nonBlank.every(l => re.test(l))
  const out = allCommented
    ? lines.map(l => l.replace(re, "$1"))
    : lines.map(l => (l.trim() === "" ? l : l.replace(/^(\s*)/, `$1${starter} `)))
  buffer.replaceRange(span.start, span.end, out.join("\n"))
}

function commentIndent(buffer: BufferModel, starter: string): void {
  const column = getCustom<number>("comment-column") ?? 32
  const line = buffer.lineBoundsAt()
  const existing = line.text.indexOf(starter)
  if (existing >= 0) {
    let p = line.start + existing + starter.length
    if (buffer.text[p] === " ") p++
    buffer.point = p
    return
  }
  const code = line.text.replace(/\s+$/, "")
  const pad = code.length === 0 ? 0 : Math.max(1, column - code.length)
  buffer.replaceRange(line.start + code.length, line.end, " ".repeat(pad) + starter + " ")
}

function nLineEnd(buffer: BufferModel, n: number): number {
  if (n >= 1) {
    let end = buffer.lineBoundsAt().end
    for (let i = 1; i < n && end < buffer.text.length; i++) end = buffer.lineBoundsAt(end + 1).end
    return end
  }
  let start = buffer.lineBoundsAt().start
  for (let i = 0; i > n && start > 0; i--) start = buffer.lineBoundsAt(start - 1).start
  return start
}

function backToIndentation(buffer: BufferModel): void {
  const line = buffer.lineBoundsAt()
  const indent = line.text.match(/^\s*/)?.[0].length ?? 0
  buffer.point = line.start + indent
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  const requireStarter = (buffer: BufferModel): string | null => {
    const starter = modeFeature(buffer.mode, "commentStart")
    if (!starter) {
      editor.message("No comment syntax is defined")
      return null
    }
    return starter
  }

  editor.command("comment-dwim", ({ buffer }) => {
    const starter = requireStarter(buffer)
    if (!starter) return
    if (useRegion(buffer)) {
      commentOrUncommentRegion(buffer, buffer.mark!, buffer.point, starter)
      return
    }
    const line = buffer.lineBoundsAt()
    if (line.text.trim() === "") {
      buffer.replaceRange(line.start, line.end, starter + " ")
      return
    }
    commentIndent(buffer, starter)
  }, "Comment/uncomment region, or insert/jump to an end-of-line comment.")

  editor.command("comment-line", ({ buffer, prefixArgument }) => {
    const starter = requireStarter(buffer)
    if (!starter) return
    if (useRegion(buffer)) {
      commentOrUncommentRegion(buffer, buffer.mark!, buffer.point, starter)
      return
    }
    const n = prefixArgument ?? 1
    const here = buffer.lineBoundsAt().start
    const far = nLineEnd(buffer, n)
    const beg = Math.min(here, far)
    const end = Math.max(here, far)
    commentOrUncommentRegion(buffer, beg, end, starter)
    const eol = buffer.lineBoundsAt().end
    buffer.point = eol < buffer.text.length ? eol + 1 : eol
    backToIndentation(buffer)
  }, "Comment or uncomment current line(s) and move to the next line.")

  editor.command("comment-or-uncomment-region", ({ buffer }) => {
    const starter = requireStarter(buffer)
    if (!starter) return
    const beg = buffer.mark ?? buffer.point
    commentOrUncommentRegion(buffer, beg, buffer.point, starter)
  }, "Comment region, or uncomment it if every line is already commented.")

  editor.key("M-;", "comment-dwim")
  editor.key("C-x C-;", "comment-line")
  // Terminals can't encode C-;, so the binding above is GUI-only.
  editor.key("C-c ;", "comment-line")
}
