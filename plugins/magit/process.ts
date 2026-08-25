import { BufferModel } from "../../src/kernel/buffer"
import type { Editor } from "../../src/kernel/editor"
import { spawnProcess } from "../../src/platform/runtime"
import { MagitSectionBuilder, setRootSection, type MagitSection } from "./section"

export type MagitGitResult = { out: string; err: string; code: number | null }

export type MagitProcessEntry = {
  args: string[]
  cwd: string
  out: string
  err: string
  code: number | null
  command?: string
}

const PROCESS_BUFFER_NAME = "*magit-process*"
const PROCESS_ENTRIES_LOCAL = "magit-process-entries"

export async function runGitLogged(
  args: string[],
  cwd: string,
  options: {
    stdin?: string
    env?: Record<string, string>
    editor?: Editor
  } = {},
): Promise<MagitGitResult> {
  const proc = spawnProcess({
    cmd: ["git", ...args],
    cwd,
    env: options.env,
    stdin: options.stdin != null ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  if (options.stdin != null && proc.stdin) {
    proc.stdin.write(options.stdin)
    proc.stdin.end()
  }
  const [out, err] = await Promise.all([
    proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
    proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
  ])
  const code = await proc.exited
  if (options.editor) {
    appendProcessEntry(options.editor, { args, cwd, out, err, code })
  }
  return { out, err, code }
}

export function appendProcessEntry(editor: Editor, entry: MagitProcessEntry): BufferModel {
  const buffer = ensureProcessBuffer(editor)
  const entries = processEntries(buffer)
  entries.push(entry)
  renderProcessBuffer(buffer, entries)
  buffer.locals.set("magit-root", entry.cwd)
  return buffer
}

export function openProcessBuffer(editor: Editor, root?: string): BufferModel {
  const buffer = ensureProcessBuffer(editor)
  if (root) buffer.locals.set("magit-root", root)
  editor.switchToBuffer(buffer.id)
  return buffer
}

export function renderProcessEntries(entries: MagitProcessEntry[]): { text: string; root: MagitSection } {
  const builder = new MagitSectionBuilder()
  builder.insertSection({ type: "process-buffer", value: PROCESS_BUFFER_NAME }, () => {
    for (const entry of entries) {
      builder.insertSection({ type: "process", value: entry.args.join(" ") }, () => {
        builder.insertHeading(`$ ${entry.command ?? `git ${entry.args.map(shellQuoteIfNeeded).join(" ")}`}`)
        const body = `${entry.out}${entry.err}`
        if (body) builder.insert(body.endsWith("\n") ? body : `${body}\n`)
        builder.insert(`[exit ${entry.code ?? "signal"}]\n\n`)
      })
    }
  })
  const text = builder.toString() || "No Magit processes have run.\n"
  builder.root.end = text.length
  return { text, root: builder.root }
}

function ensureProcessBuffer(editor: Editor): BufferModel {
  const existing = [...editor.buffers.values()].find(buffer => buffer.name === PROCESS_BUFFER_NAME)
  if (existing) return existing
  const buffer = new BufferModel({ name: PROCESS_BUFFER_NAME, text: "", kind: "scratch", mode: "magit-process-mode" })
  editor.addBuffer(buffer)
  editor.enterMode(buffer, "magit-process-mode")
  buffer.readOnly = true
  buffer.locals.set(PROCESS_ENTRIES_LOCAL, [])
  renderProcessBuffer(buffer, [])
  return buffer
}

function processEntries(buffer: BufferModel): MagitProcessEntry[] {
  const existing = buffer.locals.get(PROCESS_ENTRIES_LOCAL) as MagitProcessEntry[] | undefined
  if (existing) return existing
  const entries: MagitProcessEntry[] = []
  buffer.locals.set(PROCESS_ENTRIES_LOCAL, entries)
  return entries
}

function renderProcessBuffer(buffer: BufferModel, entries: MagitProcessEntry[]): void {
  const { text, root } = renderProcessEntries(entries)
  const wasReadOnly = buffer.readOnly
  buffer.readOnly = false
  buffer.setText(text, false, false)
  buffer.readOnly = wasReadOnly
  setRootSection(buffer, root)
}

function shellQuoteIfNeeded(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}
