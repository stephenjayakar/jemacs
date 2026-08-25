import type { Editor } from "../../src/kernel/editor"
import type { BufferModel } from "../../src/kernel/buffer"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { defcustom, getCustom } from "../../src/runtime/custom"
import { getTrackedAdvice } from "../../src/runtime/advice"
import { modeFeature, modeLineage } from "../../src/modes/mode"

const FILL_COLUMN_LOCAL = "fill-column"

type LineInfo = { offsets: number[]; lines: string[] }
type ParagraphSpan = { startLine: number; endLine: number; start: number; end: number }

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  defcustom("fill-column", "integer", 70,
    "Column beyond which automatic line-wrapping should happen.", "fill")

  editor.command("fill-paragraph", ({ buffer }) => {
    fillParagraphAt(buffer, buffer.point)
  }, "Fill paragraph at or after point.")

  editor.command("fill-region", ({ buffer }) => {
    if (buffer.mark == null || buffer.mark === buffer.point) return
    const [start, end] = [buffer.mark, buffer.point].sort((a, b) => a - b)
    fillRegion(buffer, start, end)
  }, "Fill each paragraph in the region.")

  ctx.minorMode({ name: "auto-fill-mode", lighter: " Fill" })

  editor.command("auto-fill-mode", ({ editor, buffer, prefixArgument }) => {
    if (prefixArgument === 1) editor.enableMinorMode("auto-fill-mode", { buffer })
    else if (prefixArgument === 0 || prefixArgument === -1) editor.disableMinorMode("auto-fill-mode", { buffer })
    else editor.toggleMinorMode("auto-fill-mode", { buffer })
  }, "Toggle automatic line breaking at `fill-column`.")

  editor.key("M-q", "fill-paragraph")

  installAutoFillAdvice(ctx)
}

function currentFillColumn(buffer: BufferModel): number {
  const local = buffer.locals.get(FILL_COLUMN_LOCAL)
  return typeof local === "number" ? local : getCustom<number>("fill-column") ?? 70
}

function lineInfo(text: string): LineInfo {
  const lines = text.split("\n")
  const offsets: number[] = new Array(lines.length)
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    offsets[i] = offset
    offset += lines[i]!.length + 1
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

function paragraphSpanAt(text: string, point: number): ParagraphSpan | null {
  const info = lineInfo(text)
  let line = lineIndexAt(info, Math.max(0, Math.min(point, text.length)))
  while (line < info.lines.length && isBlank(info.lines[line]!)) line++
  if (line >= info.lines.length) return null

  let startLine = line
  while (startLine > 0 && !isBlank(info.lines[startLine - 1]!)) startLine--
  let endLine = line
  while (endLine + 1 < info.lines.length && !isBlank(info.lines[endLine + 1]!)) endLine++

  const start = info.offsets[startLine]!
  const end = info.offsets[endLine]! + info.lines[endLine]!.length
  return { startLine, endLine, start, end }
}

function paragraphSpansInRegion(text: string, start: number, end: number): ParagraphSpan[] {
  const spans: ParagraphSpan[] = []
  const info = lineInfo(text)
  const fromLine = lineIndexAt(info, start)
  const toLine = lineIndexAt(info, Math.max(start, end - 1))
  let line = fromLine
  while (line <= toLine && line < info.lines.length) {
    if (isBlank(info.lines[line]!)) {
      line++
      continue
    }
    const spanStartLine = line
    while (line + 1 < info.lines.length && line + 1 <= toLine && !isBlank(info.lines[line + 1]!)) line++
    const spanEndLine = line
    const spanStart = info.offsets[spanStartLine]!
    const spanEnd = info.offsets[spanEndLine]! + info.lines[spanEndLine]!.length
    spans.push({ startLine: spanStartLine, endLine: spanEndLine, start: spanStart, end: spanEnd })
    line++
  }
  return spans
}

function fillParagraphAt(buffer: BufferModel, point: number): void {
  const span = paragraphSpanAt(buffer.text, point)
  if (!span) return
  fillSpan(buffer, span)
}

function fillRegion(buffer: BufferModel, start: number, end: number): void {
  const spans = paragraphSpansInRegion(buffer.text, start, end)
  for (let i = spans.length - 1; i >= 0; i--) fillSpan(buffer, spans[i]!)
}

function fillSpan(buffer: BufferModel, span: ParagraphSpan): void {
  const original = buffer.text.slice(span.start, span.end)
  const lines = original.split("\n")
  const replacement = fillLines(buffer, lines)
  buffer.replaceRange(span.start, span.end, replacement)
}

function fillLines(buffer: BufferModel, lines: string[]): string {
  const commentStart = commentPrefixFor(buffer, lines)
  if (commentStart) return fillCommentLines(buffer, lines, commentStart)
  return fillPlainLines(buffer, lines)
}

function fillPlainLines(buffer: BufferModel, lines: string[]): string {
  const firstIndent = indentOf(lines[0] ?? "")
  const restIndent = lines.length > 1 ? indentOf(lines[1]!) : firstIndent
  const words = lines.map(line => line.trim()).join(" ").trim().split(/\s+/).filter(Boolean)
  return wrapWords(words, firstIndent, restIndent, currentFillColumn(buffer)).join("\n")
}

function fillCommentLines(buffer: BufferModel, lines: string[], commentStart: string): string {
  const firstIndent = indentOf(lines[0] ?? "")
  const restIndent = lines.length > 1 ? indentOf(lines[1]!) : firstIndent
  const firstPrefix = `${firstIndent}${commentStart} `
  const restPrefix = `${restIndent}${commentStart} `
  const words = lines.map(line => stripCommentText(line, commentStart)).join(" ").trim().split(/\s+/).filter(Boolean)
  return wrapWords(words, firstPrefix, restPrefix, currentFillColumn(buffer)).join("\n")
}

function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? ""
}

function commentPrefixFor(buffer: BufferModel, lines: string[]): string | null {
  if (!modeLineage(buffer.mode).some(mode => mode.name === "prog-mode")) return null
  const commentStart = modeFeature(buffer.mode, "commentStart")
  if (!commentStart) return null
  return lines.every(line => line.trim() === "" || line.trimStart().startsWith(commentStart))
    ? commentStart
    : null
}

function stripCommentText(line: string, commentStart: string): string {
  const trimmed = line.trimStart()
  if (!trimmed.startsWith(commentStart)) return trimmed.trim()
  return trimmed.slice(commentStart.length).trim()
}

function wrapWords(words: string[], firstPrefix: string, restPrefix: string, fillColumn: number): string[] {
  if (words.length === 0) return [firstPrefix.trimEnd()]
  const lines: string[] = []
  let prefix = firstPrefix
  let current = prefix
  for (const word of words) {
    const separator = current === prefix ? "" : " "
    if (current !== prefix && current.length + separator.length + word.length > fillColumn) {
      lines.push(current)
      prefix = restPrefix
      current = prefix + word
    } else {
      current += separator + word
    }
  }
  lines.push(current)
  return lines
}

let selfInsertAdviceId: string | undefined
let newlineAdviceId: string | undefined

function installAutoFillAdvice(ctx: PluginContext): void {
  if (selfInsertAdviceId === undefined || getTrackedAdvice(selfInsertAdviceId) === undefined) {
    selfInsertAdviceId = ctx.advice("self-insert-command", {
      after: ({ editor, buffer, args, keyEvent }) => {
        const inserted = args[0] ?? keyEvent?.sequence ?? editor.lastKeyEvent?.sequence
        if (inserted === " ") maybeAutoFill(editor, buffer, buffer.point)
      },
    })
    ctx.onDispose(() => { selfInsertAdviceId = undefined })
  }

  if (newlineAdviceId === undefined || getTrackedAdvice(newlineAdviceId) === undefined) {
    newlineAdviceId = ctx.advice("newline", {
      after: ({ editor, buffer }) => maybeAutoFill(editor, buffer, Math.max(0, buffer.point - 1)),
    })
    ctx.onDispose(() => { newlineAdviceId = undefined })
  }
}

function maybeAutoFill(editor: Editor, buffer: BufferModel, point: number): void {
  if (!editor.isMinorModeEnabled("auto-fill-mode", buffer)) return
  autoFillLine(buffer, point)
}

function autoFillLine(buffer: BufferModel, point: number): void {
  const line = buffer.lineBoundsAt(point)
  const fillColumn = currentFillColumn(buffer)
  if (line.text.length <= fillColumn) return
  const breakAt = lastBreakBefore(line.text, fillColumn)
  if (breakAt == null) return
  const indent = indentOf(line.text)
  buffer.replaceRange(line.start + breakAt.start, line.start + breakAt.end, `\n${indent}`)
}

function lastBreakBefore(line: string, fillColumn: number): { start: number; end: number } | null {
  const limit = Math.min(fillColumn, line.length)
  let best: { start: number; end: number } | null = null
  const re = /[ \t]+/g
  for (let match = re.exec(line); match; match = re.exec(line)) {
    const start = match.index
    const end = start + match[0].length
    if (start === 0) continue
    if (end <= limit) best = { start, end }
    else break
  }
  return best
}
