import type { Editor } from "../../src/kernel/editor"
import type { BufferModel } from "../../src/kernel/buffer"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { defcustom, getCustom, setCustom } from "../../src/runtime/custom"
import { spawnProcess } from "../../src/platform/runtime"

/**
 * Run an external formatter on save.
 *
 * Emacs gets this from `gofmt-before-save` plus `prettier-js-mode`; both are per-language
 * packages doing the same thing, so this is one table-driven implementation instead.
 *
 * Formatters run as filters -- text in on stdin, text out on stdout -- which avoids
 * writing a temp file and keeps an unsaved buffer's contents authoritative. A formatter
 * that fails leaves the buffer untouched and reports; a save is never blocked by a
 * missing binary, because losing the save is worse than losing the formatting.
 */

export type Formatter = {
  /** Major modes this applies to. */
  modes: string[]
  /** argv; the buffer text is piped to stdin. */
  command: string[]
}

defcustom(
  "format-on-save",
  "boolean",
  true,
  "Run the configured formatter for the buffer's mode before saving.",
)

defcustom(
  "format-on-save-timeout",
  "number",
  5000,
  "Milliseconds to wait for a formatter before giving up.",
)

defcustom<Formatter[]>(
  "format-on-save-formatters",
  "sexp",
  [
    // `goimports` rather than `gofmt`: it also fixes the import block, which is what
    // Stephen's init.el sets `gofmt-command` to.
    { modes: ["go"], command: ["goimports"] },
    { modes: ["typescript", "javascript", "json", "css-mode", "scss-mode"], command: ["prettier", "--stdin-filepath"] },
    { modes: ["rust"], command: ["rustfmt", "--emit", "stdout"] },
    { modes: ["python"], command: ["black", "-q", "-"] },
  ],
  "Formatters to run on save, matched against the buffer's major mode.",
)

export function formatterFor(mode: string, formatters: Formatter[]): Formatter | null {
  for (const formatter of formatters) {
    if (formatter.modes.includes(mode)) return formatter
  }
  return null
}

/**
 * Build the argv for `buffer`.
 *
 * `prettier --stdin-filepath` needs the filename appended so prettier can pick a parser;
 * the marker is expanded here rather than special-casing prettier at the call site.
 */
export function resolveCommand(formatter: Formatter, path: string | undefined): string[] {
  const argv = [...formatter.command]
  if (argv[argv.length - 1] === "--stdin-filepath") {
    if (!path) return argv.slice(0, -1)
    argv.push(path)
  }
  return argv
}

/** Run `argv` with `input` on stdin, returning stdout, or null when it fails. */
async function runFilter(argv: string[], input: string, timeoutMs: number): Promise<string | null> {
  const proc = spawnProcess({ cmd: argv, stdin: "pipe", stdout: "pipe", stderr: "pipe" })

  proc.stdin?.write(input)
  proc.stdin?.end()

  const collect = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
    if (!stream) return ""
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let text = ""
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value?.length) text += decoder.decode(value, { stream: true })
    }
    return text
  }

  const timeout = new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs))
  const work = (async () => {
    const [stdout, stderr] = await Promise.all([collect(proc.stdout), collect(proc.stderr)])
    const code = await proc.exited
    return code === 0 ? stdout : Promise.reject(new Error(stderr.trim() || `exited ${code}`))
  })()

  const result = await Promise.race([work, timeout])
  if (result === null) {
    proc.kill()
    throw new Error("formatter timed out")
  }
  return result
}

/**
 * Format `buffer` in place, preserving point.
 *
 * Point is restored by line/column rather than raw offset: a formatter shifts offsets
 * arbitrarily, so an offset would land the cursor somewhere unrelated.
 */
export async function formatBuffer(editor: Editor, buffer: BufferModel): Promise<boolean> {
  const formatters = getCustom<Formatter[]>("format-on-save-formatters") ?? []
  const formatter = formatterFor(buffer.mode, formatters)
  if (!formatter) return false

  const argv = resolveCommand(formatter, buffer.path)
  const original = buffer.text
  let formatted: string | null
  try {
    formatted = await runFilter(argv, original, getCustom<number>("format-on-save-timeout") ?? 5000)
  } catch (err) {
    // A missing or unhappy formatter must not block the save.
    editor.message(`${argv[0]}: ${(err as Error).message}`)
    return false
  }
  if (formatted == null || formatted === original) return false
  // A formatter that returns nothing has almost certainly errored; discard the result
  // rather than emptying the user's file.
  if (!formatted.trim() && original.trim()) {
    editor.message(`${argv[0]}: produced empty output, leaving buffer unchanged`)
    return false
  }

  const { line, col } = lineColumn(original, buffer.point)
  buffer.replaceRange(0, original.length, formatted)
  buffer.point = offsetFor(formatted, line, col)
  return true
}

function lineColumn(text: string, offset: number): { line: number; col: number } {
  let line = 0
  let lineStart = 0
  const limit = Math.min(offset, text.length)
  for (let i = 0; i < limit; i++) {
    if (text[i] === "\n") {
      line++
      lineStart = i + 1
    }
  }
  return { line, col: limit - lineStart }
}

function offsetFor(text: string, line: number, col: number): number {
  let offset = 0
  for (let i = 0; i < line; i++) {
    const next = text.indexOf("\n", offset)
    if (next === -1) return Math.min(offset + col, text.length)
    offset = next + 1
  }
  const lineEnd = text.indexOf("\n", offset)
  const maxCol = (lineEnd === -1 ? text.length : lineEnd) - offset
  return offset + Math.min(col, Math.max(0, maxCol))
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  ctx.command("format-buffer", async ({ editor, buffer }) => {
    const changed = await formatBuffer(editor, buffer)
    editor.message(changed ? "Formatted buffer" : "No formatter for this buffer (or already formatted)")
  }, "Run the configured formatter for this buffer's mode.")

  ctx.command("format-on-save-mode", ({ editor, prefixArgument }) => {
    const enable = prefixArgument == null
      ? !(getCustom<boolean>("format-on-save") ?? true)
      : prefixArgument > 0
    setCustom("format-on-save", enable)
    editor.message(enable ? "Format-on-save enabled" : "Format-on-save disabled")
  }, "Toggle running formatters on save.")

  ctx.hook("before-save-hook", async ({ buffer }) => {
    if (!(getCustom<boolean>("format-on-save") ?? true)) return
    await formatBuffer(editor, buffer as BufferModel)
  })
}
