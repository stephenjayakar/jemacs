import type { BufferModel } from "../kernel/buffer"
import type { Editor } from "../kernel/editor"
import { Keymap } from "../kernel/keymap"
import { defcustom, getCustom } from "../runtime/custom"
import { defineMode, type FontLockRange, type TextSpan } from "./mode"

type Line = { text: string; start: number; end: number }

const DEFAULT_OUTLINE_REGEXP = "\\*+"
const outlineHeadingFaces: TextSpan["face"][] = ["keyword", "function", "type", "constant", "builtin", "string"]

defcustom("outline-regexp", "string", DEFAULT_OUTLINE_REGEXP, "Regexp matching outline headings.", "outline")

export function installOutlineMode(): void {
  const keymap = new Keymap("outline-mode-map")
  keymap.bind("C-c C-n", "outline-next-visible-heading")
  keymap.bind("C-c C-p", "outline-previous-visible-heading")
  defineMode({
    name: "outline-mode",
    parent: "text",
    keymap,
    fontLock: outlineFontLock,
  })
}

export function installOutlineCommands(editor: Editor): void {
  editor.command("outline-next-visible-heading", ({ buffer, editor, prefixArgument }) => {
    if (!outlineNextVisibleHeading(buffer, prefixCount(prefixArgument))) editor.message("No next heading")
  }, "Move to the next visible heading line.")

  editor.command("outline-previous-visible-heading", ({ buffer, editor, prefixArgument }) => {
    if (!outlinePreviousVisibleHeading(buffer, prefixCount(prefixArgument))) editor.message("No previous heading")
  }, "Move to the previous visible heading line.")
}

export function outlineFontLock(buffer: BufferModel, range?: FontLockRange): TextSpan[] {
  const spans: TextSpan[] = []
  const { text, offset } = fontLockSlice(buffer, range)
  const regexp = outlineHeadingRegexp()
  for (const line of textLines(text)) {
    const match = line.text.match(regexp)
    if (!match) continue
    spans.push({
      start: offset + line.start,
      end: offset + line.end,
      face: outlineHeadingFace(match[0].length),
    })
  }
  return spans.sort((a, b) => a.start - b.start || a.end - b.end)
}

export function outlineNextVisibleHeading(buffer: BufferModel, count = 1): boolean {
  return moveToHeading(buffer, count)
}

export function outlinePreviousVisibleHeading(buffer: BufferModel, count = 1): boolean {
  return moveToHeading(buffer, -count)
}

function moveToHeading(buffer: BufferModel, count: number): boolean {
  if (count === 0) return true
  const headings = outlineHeadings(buffer.text)
  const lineStart = buffer.lineBoundsAt().start
  if (count > 0) {
    const first = headings.findIndex(start => start > lineStart)
    const target = first < 0 ? undefined : headings[first + count - 1]
    if (target == null) return false
    buffer.point = target
    return true
  }

  const previous = lastIndexWhere(headings, start => start < lineStart)
  const target = previous < 0 ? undefined : headings[previous + count + 1]
  if (target == null) return false
  buffer.point = target
  return true
}

function outlineHeadings(text: string): number[] {
  const headings: number[] = []
  const regexp = outlineHeadingRegexp()
  for (const line of textLines(text)) {
    const match = line.text.match(regexp)
    if (match) headings.push(line.start)
  }
  return headings
}

function outlineHeadingRegexp(): RegExp {
  const source = getCustom<string>("outline-regexp") ?? DEFAULT_OUTLINE_REGEXP
  try {
    return new RegExp(`^(?:${source})`)
  } catch {
    return new RegExp(`^(?:${DEFAULT_OUTLINE_REGEXP})`)
  }
}

function outlineHeadingFace(level: number): TextSpan["face"] {
  return outlineHeadingFaces[Math.min(Math.max(level, 1), outlineHeadingFaces.length) - 1]!
}

function prefixCount(prefixArgument: number | null): number {
  return prefixArgument == null ? 1 : prefixArgument
}

function lastIndexWhere<T>(values: T[], predicate: (value: T) => boolean): number {
  for (let i = values.length - 1; i >= 0; i--) if (predicate(values[i]!)) return i
  return -1
}

function textLines(text: string): Line[] {
  const lines: Line[] = []
  let start = 0
  while (start <= text.length) {
    const end = lineEnd(text, start)
    lines.push({ text: text.slice(start, end), start, end })
    if (end === text.length) break
    start = end + 1
  }
  return lines
}

function lineEnd(text: string, start: number): number {
  const end = text.indexOf("\n", start)
  return end === -1 ? text.length : end
}

function fontLockSlice(buffer: BufferModel, range?: FontLockRange): { text: string; offset: number } {
  if (!range) return { text: buffer.text, offset: 0 }
  const startLine = Math.max(0, Math.min(range.startLine, buffer.lineCount - 1))
  const endLine = Math.max(startLine, Math.min(range.endLine, buffer.lineCount))
  const start = buffer.lineStarts[startLine] ?? 0
  const end = endLine < buffer.lineCount ? buffer.lineStarts[endLine]! : buffer.text.length
  return { text: buffer.text.slice(start, end), offset: start }
}
