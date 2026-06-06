import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { BufferModel } from "../../src/kernel/buffer"

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  editor.command("back-to-indentation", ({ buffer }) => {
    backToIndentation(buffer)
  }, "Move point to the first non-whitespace character on this line.")

  editor.command("forward-paragraph", ({ buffer, prefixArgument }) => {
    moveParagraph(buffer, prefixArgument ?? 1)
  }, "Move forward to end of paragraph.")

  editor.command("backward-paragraph", ({ buffer, prefixArgument }) => {
    moveParagraph(buffer, -(prefixArgument ?? 1))
  }, "Move backward to start of paragraph.")

  editor.command("transpose-words", ({ buffer, editor }) => {
    if (!transposeWords(buffer)) editor.message("Don't have two things to transpose")
  }, "Interchange words around point, leaving point at end of them.")

  editor.command("transpose-lines", ({ buffer, editor }) => {
    if (!transposeLines(buffer)) editor.message("Don't have two things to transpose")
  }, "Exchange current line and previous line, leaving point after both.")

  editor.key("M-m", "back-to-indentation")
  editor.key("M-}", "forward-paragraph")
  editor.key("M-{", "backward-paragraph")
  editor.key("M-t", "transpose-words")
  editor.key("C-x C-t", "transpose-lines")
}

function backToIndentation(buffer: BufferModel): void {
  const { start, end, text } = buffer.lineBoundsAt()
  const match = /^[ \t]*/.exec(text)
  buffer.point = Math.min(start + (match ? match[0].length : 0), end)
}

type LineInfo = { offsets: number[]; lines: string[] }

function lineInfo(text: string): LineInfo {
  const lines = text.split("\n")
  const offsets: number[] = new Array(lines.length)
  let off = 0
  for (let i = 0; i < lines.length; i++) {
    offsets[i] = off
    off += lines[i]!.length + 1
  }
  return { offsets, lines }
}

function lineIndexAt(info: LineInfo, point: number): number {
  let lo = 0
  let hi = info.offsets.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (info.offsets[mid]! <= point) lo = mid
    else hi = mid - 1
  }
  return lo
}

const isBlank = (s: string): boolean => /^[ \t\f]*$/.test(s)

function paragraphBoundaries(info: LineInfo): number[] {
  const bounds: number[] = []
  for (let i = 1; i < info.lines.length; i++) {
    if (isBlank(info.lines[i]!) && !isBlank(info.lines[i - 1]!)) bounds.push(info.offsets[i]!)
  }
  return bounds
}

function moveParagraph(buffer: BufferModel, n: number): void {
  if (n === 0) return
  const text = buffer.text
  const info = lineInfo(text)
  const bounds = paragraphBoundaries(info)
  let point = buffer.point
  if (n > 0) {
    for (let k = 0; k < n; k++) {
      const next = bounds.find(b => b > point)
      point = next ?? text.length
      if (point === text.length) break
    }
  } else {
    for (let k = 0; k < -n; k++) {
      let prev: number | undefined
      for (let i = bounds.length - 1; i >= 0; i--) {
        if (bounds[i]! < point) { prev = bounds[i]!; break }
      }
      point = prev ?? 0
      if (point === 0) break
    }
  }
  buffer.point = point
}

function forwardWordEnd(text: string, p: number): number {
  const m = /[^A-Za-z0-9_]*[A-Za-z0-9_]+/.exec(text.slice(p))
  return m ? p + m[0].length : text.length
}

function backwardWordStart(text: string, p: number): number {
  let last: RegExpExecArray | null = null
  const re = /[A-Za-z0-9_]+/g
  const head = text.slice(0, p)
  for (let m = re.exec(head); m; m = re.exec(head)) last = m
  return last ? last.index : 0
}

function wordAround(text: string, p: number, dir: 1 | -1): [number, number] {
  if (dir < 0) {
    const a = backwardWordStart(text, p)
    const b = forwardWordEnd(text, a)
    return [a, b]
  }
  const b = forwardWordEnd(text, p)
  const a = backwardWordStart(text, b)
  return [a, b]
}

function transposeWords(buffer: BufferModel): boolean {
  const text = buffer.text
  const [s1, e1] = wordAround(text, buffer.point, -1)
  const [s2, e2] = wordAround(text, e1, 1)
  return transposeRanges(buffer, s1, e1, s2, e2)
}

function transposeLines(buffer: BufferModel): boolean {
  const bol = lineStart(buffer.text, buffer.point)
  if (bol === 0) return false
  const prevBol = lineStart(buffer.text, bol - 1)
  let eol = buffer.text.indexOf("\n", bol)
  if (eol === -1) {
    buffer.replaceRange(buffer.text.length, buffer.text.length, "\n")
    eol = buffer.text.length - 1
  }
  return transposeRanges(buffer, prevBol, bol, bol, eol + 1)
}

function lineStart(text: string, p: number): number {
  return p <= 0 ? 0 : text.lastIndexOf("\n", p - 1) + 1
}

function transposeRanges(buffer: BufferModel, s1: number, e1: number, s2: number, e2: number): boolean {
  let a1 = Math.min(s1, e1), b1 = Math.max(s1, e1)
  let a2 = Math.min(s2, e2), b2 = Math.max(s2, e2)
  if (a1 > a2) { [a1, b1, a2, b2] = [a2, b2, a1, b1] }
  if (b1 > a2 || (a1 === a2 && b1 === b2)) return false
  const text = buffer.text
  const first = text.slice(a1, b1)
  const second = text.slice(a2, b2)
  const rebuilt = text.slice(0, a1) + second + text.slice(b1, a2) + first + text.slice(b2)
  buffer.setText(rebuilt, true)
  buffer.point = b2
  return true
}
