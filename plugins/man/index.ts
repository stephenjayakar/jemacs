import type { BufferModel } from "../../src/kernel/buffer"
import type { Editor } from "../../src/kernel/editor"
import { Keymap } from "../../src/kernel/keymap"
import { defineMode, type TextSpan } from "../../src/modes/mode"
import { spawnProcess } from "../../src/platform/runtime"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"

type MaybePromise<T> = T | Promise<T>

export type ManBackendOptions = {
  width: number
}

export type ManBackend = (topic: string, options: ManBackendOptions) => MaybePromise<string | null | undefined>
export type ManAproposBackend = () => MaybePromise<string | null | undefined>

export const MAN_TOPIC_LOCAL = "man-topic"
export const MAN_SPANS_LOCAL = "man-spans"
export const MAN_WIDTH_LOCAL = "man-width"

const COMPLETION_TIMEOUT_MS = 300
const TIMEOUT = Symbol("man-timeout")

const backendRef: { page: ManBackend; apropos: ManAproposBackend | null } = {
  page: defaultManBackend,
  apropos: defaultManAproposBackend,
}

export function setManBackend(page: ManBackend, apropos: ManAproposBackend | null = null): () => void {
  const previous = { ...backendRef }
  backendRef.page = page
  backendRef.apropos = apropos
  return () => {
    backendRef.page = previous.page
    backendRef.apropos = previous.apropos
  }
}

type RenderCell = {
  ch: string
  bold?: boolean
  underline?: boolean
  italic?: boolean
}

export type RenderedManPage = {
  text: string
  spans: TextSpan[]
}

export function stripManOverstrikes(raw: string): RenderedManPage {
  const textParts: string[] = []
  const spans: TextSpan[] = []
  const lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
  let offset = 0

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const cells = renderOverstrikeLine(lines[lineIndex]!)
    for (const cell of cells) {
      textParts.push(cell.ch)
      const end = offset + cell.ch.length
      appendCellSpan(spans, offset, end, cell)
      offset = end
    }
    if (lineIndex < lines.length - 1) {
      textParts.push("\n")
      offset++
    }
  }

  return { text: textParts.join(""), spans }
}

function renderOverstrikeLine(rawLine: string): RenderCell[] {
  const cells: RenderCell[] = []
  let column = 0
  for (const ch of rawLine) {
    if (ch === "\b") {
      column = Math.max(0, column - 1)
      continue
    }

    const existing = cells[column]
    if (!existing) cells[column] = { ch }
    else applyOverstrike(existing, ch)
    column++
  }
  return cells
}

function applyOverstrike(cell: RenderCell, ch: string): void {
  if (cell.ch === ch) {
    cell.bold = true
    return
  }
  if (cell.ch === "_" && ch !== "_") {
    cell.ch = ch
    cell.underline = true
    cell.italic = true
    return
  }
  if (ch === "_" && cell.ch !== "_") {
    cell.underline = true
    cell.italic = true
    return
  }
  cell.ch = ch
}

function appendCellSpan(spans: TextSpan[], start: number, end: number, cell: RenderCell): void {
  if (!cell.bold && !cell.underline && !cell.italic) return
  const style = {
    ...(cell.bold ? { bold: true } : {}),
    ...(cell.underline ? { underline: true } : {}),
    ...(cell.italic ? { italic: true } : {}),
  }
  const key = spanStyleKey(cell)
  const last = spans.at(-1)
  if (last && last.end === start && textSpanStyleKey(last) === key) {
    last.end = end
    return
  }
  spans.push({ start, end, face: "default", style })
}

function spanStyleKey(cell: RenderCell): string {
  return `${cell.bold ? "b" : ""}${cell.underline ? "u" : ""}${cell.italic ? "i" : ""}`
}

function textSpanStyleKey(span: TextSpan): string {
  const style = span.style
  return `${style?.bold ? "b" : ""}${style?.underline ? "u" : ""}${style?.italic ? "i" : ""}`
}

export function isManSectionHeader(line: string): boolean {
  return /^[A-Z][A-Z0-9 _-]*$/.test(line) && /[A-Z]/.test(line)
}

export function manSectionLines(buffer: BufferModel): number[] {
  const lines = buffer.text.split("\n")
  const out: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (isManSectionHeader(lines[i]!)) out.push(i)
  }
  return out
}

const MAN_REFERENCE_RE = /\b([A-Za-z0-9][A-Za-z0-9_.:+-]*)\(([0-9A-Za-z][0-9A-Za-z+.-]*)\)/g

export function manReferenceAt(buffer: BufferModel, point = buffer.point): string | null {
  const line = buffer.lineBoundsAt(point)
  const column = point - line.start
  for (const match of line.text.matchAll(MAN_REFERENCE_RE)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    if (column >= start && column <= end) return match[0]
  }
  return null
}

export function parseManApropos(text: string): string[] {
  const seen = new Set<string>()
  for (const raw of text.split("\n")) {
    const head = raw.split(/\s+-\s+/, 1)[0]?.trim()
    if (!head) continue
    for (const part of head.split(",")) {
      const entry = part.trim()
      if (!entry) continue
      const match = /^(\S+)\s*(\([^)]+\))?/.exec(entry)
      if (!match) continue
      const candidate = `${match[1]}${match[2] ?? ""}`
      if (candidate) seen.add(candidate)
      if (seen.size >= 2000) return [...seen]
    }
  }
  return [...seen]
}

async function readManTopic(editor: Editor, args: string[]): Promise<string | null> {
  const explicit = args[0]?.trim()
  if (explicit) return explicit

  const collection = await manCompletionCandidatesFast()
  if (collection?.length) {
    return editor.completingRead("Manual entry: ", { collection, history: "man" })
  }
  return editor.prompt("Manual entry: ", "", "man")
}

async function manCompletionCandidatesFast(): Promise<string[] | undefined> {
  const apropos = backendRef.apropos
  if (!apropos) return undefined
  try {
    const raw = await withTimeout(Promise.resolve(apropos()), COMPLETION_TIMEOUT_MS)
    if (raw === TIMEOUT || !raw) return undefined
    const candidates = parseManApropos(raw)
    return candidates.length ? candidates : undefined
  } catch {
    return undefined
  }
}

async function runManCommand(editor: Editor, args: string[]): Promise<BufferModel | null> {
  const topic = await readManTopic(editor, args)
  if (!topic) return null
  return renderManPage(editor, topic)
}

async function renderManPage(editor: Editor, topic: string): Promise<BufferModel | null> {
  const width = windowWidth(editor)
  let raw: string | null | undefined
  try {
    raw = await backendRef.page(topic, { width })
  } catch {
    raw = null
  }
  if (!raw?.trim()) {
    editor.message(`No manual entry for ${topic}`)
    return null
  }

  const rendered = stripManOverstrikes(raw)
  const buffer = editor.scratch(`*Man ${topic}*`, rendered.text, "man-mode")
  buffer.locals.set(MAN_TOPIC_LOCAL, topic)
  buffer.locals.set(MAN_SPANS_LOCAL, rendered.spans)
  buffer.locals.set(MAN_WIDTH_LOCAL, width)
  buffer.readOnly = true
  buffer.point = 0
  editor.message(`Man page ${topic}`)
  return buffer
}

function manFontLock(buffer: BufferModel): TextSpan[] {
  return (buffer.locals.get(MAN_SPANS_LOCAL) as TextSpan[] | undefined) ?? []
}

function moveManSection(editor: Editor, buffer: BufferModel, direction: 1 | -1): void {
  const sections = manSectionLines(buffer)
  const currentLine = buffer.lineAt(buffer.point)
  const target = direction > 0
    ? sections.find(line => line > currentLine)
    : [...sections].reverse().find(line => line < currentLine)
  if (target == null) {
    editor.message(direction > 0 ? "No next section" : "No previous section")
    return
  }
  buffer.point = buffer.lineStarts[target] ?? buffer.point
}

function windowWidth(editor: Editor): number {
  const bodyCols = editor.currentBuffer.locals.get("window-body-cols")
  const width = typeof bodyCols === "number"
    ? bodyCols
    : editor.lastViewport?.cols ?? process.stdout?.columns ?? 80
  return Math.max(1, Math.trunc(width))
}

async function defaultManBackend(topic: string, options: ManBackendOptions): Promise<string | null> {
  const result = await runProcessText({
    cmd: manCommandForTopic(topic),
    env: manEnv(options.width),
  })
  if (result.exit === 0 && result.stdout.trim()) return result.stdout
  if (result.stdout.trim()) return result.stdout
  return null
}

async function defaultManAproposBackend(): Promise<string | null> {
  const result = await runProcessText({
    cmd: ["man", "-k", "."],
    env: manEnv(80),
    timeoutMs: COMPLETION_TIMEOUT_MS,
  })
  if (result.timedOut || result.exit !== 0 || !result.stdout.trim()) return null
  return result.stdout
}

function manCommandForTopic(topic: string): string[] {
  const ref = /^([A-Za-z0-9][A-Za-z0-9_.:+-]*)\(([0-9A-Za-z][0-9A-Za-z+.-]*)\)$/.exec(topic)
  if (ref) return ["man", ref[2]!, ref[1]!]
  return ["man", topic]
}

function manEnv(width: number): Record<string, string> {
  return {
    MANWIDTH: String(width),
    PAGER: "cat",
    MANPAGER: "cat",
  }
}

type ProcessTextResult = {
  stdout: string
  stderr: string
  exit: number | null
  timedOut: boolean
}

async function runProcessText(options: { cmd: string[]; env?: Record<string, string>; timeoutMs?: number }): Promise<ProcessTextResult> {
  try {
    const proc = spawnProcess({
      cmd: options.cmd,
      env: options.env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const output = Promise.all([
      proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
      proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
      proc.exited,
    ]).then(([stdout, stderr, exit]) => ({ stdout, stderr, exit, timedOut: false }))
      .catch(() => ({ stdout: "", stderr: "", exit: null, timedOut: false }))

    if (!options.timeoutMs) return output
    const result = await withTimeout(output, options.timeoutMs)
    if (result === TIMEOUT) {
      proc.kill()
      return { stdout: "", stderr: "", exit: null, timedOut: true }
    }
    return result
  } catch {
    return { stdout: "", stderr: "", exit: null, timedOut: false }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<typeof TIMEOUT>(resolve => {
        timer = setTimeout(() => resolve(TIMEOUT), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  const keymap = new Keymap("man-mode-map")
  keymap.bind("q", "quit-window")
  keymap.bind("n", "man-next-section")
  keymap.bind("p", "man-previous-section")
  keymap.bind("enter", "man-follow-reference")
  keymap.bind("return", "man-follow-reference")
  keymap.bind("RET", "man-follow-reference")
  keymap.bind("g", "man-revert")
  defineMode({
    name: "man-mode",
    parent: "text",
    keymap,
    onEnter: buffer => { buffer.readOnly = true },
    fontLock: manFontLock,
  })

  ctx.command("man", async ({ editor, args }) => runManCommand(editor, args),
    "Display the Unix manual page for a topic.")

  ctx.command("woman", async ({ editor, args }) => runManCommand(editor, args),
    "Alias for man.")

  ctx.command("man-mode", ({ editor, buffer }) => {
    editor.enterMode(buffer, "man-mode")
  }, "Major mode for Unix manual pages.")

  ctx.command("man-next-section", ({ editor, buffer }) => {
    moveManSection(editor, buffer, 1)
  }, "Move to the next section in a man page.")

  ctx.command("man-previous-section", ({ editor, buffer }) => {
    moveManSection(editor, buffer, -1)
  }, "Move to the previous section in a man page.")

  ctx.command("man-follow-reference", async ({ editor, buffer }) => {
    const reference = manReferenceAt(buffer)
    if (!reference) {
      editor.message("No man page reference at point")
      return
    }
    await renderManPage(editor, reference)
  }, "Open the man page reference at point.")

  ctx.command("man-revert", async ({ editor, buffer }) => {
    const topic = buffer.locals.get(MAN_TOPIC_LOCAL) as string | undefined
    if (!topic) {
      editor.message("No man page to rerender")
      return
    }
    await renderManPage(editor, topic)
  }, "Re-render the current man page.")
}
