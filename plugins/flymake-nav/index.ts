import { relative } from "node:path"
import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { BufferModel } from "../../src/kernel/buffer"
import type { LspDiagnostic } from "../../src/lsp/buffer-state"
import { positionToPoint } from "../../src/lsp/positions"
import { defcustom, getCustom } from "../../src/runtime/custom"
import { defineMode } from "../../src/modes/mode"
import { Keymap } from "../../src/kernel/keymap"
import { setLocationList, type ErrorLocation } from "../next-error"

type FlymakeDiag = {
  start: number
  message: string
  severity: number
  source?: string
}

defcustom("flymake-wrap-around", "boolean", true,
  "If non-nil, navigation past the last diagnostic wraps around the buffer.")

function echoLine(message: string): string {
  for (const line of message.split("\n")) {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith("```")) return trimmed
  }
  return message
}

function severityLabel(severity: number): string {
  if (severity === 1) return "error"
  if (severity === 2) return "warning"
  if (severity === 3) return "info"
  return "note"
}

function bufferDiagnostics(editor: Editor, buffer: BufferModel): FlymakeDiag[] {
  const lsp = editor.lsp
  if (!lsp || !buffer.path) return []
  const out: FlymakeDiag[] = []
  for (const ws of lsp.bufferWorkspaces(buffer)) {
    for (const d of ws.diagnosticsByPath.get(buffer.path) ?? []) {
      out.push({
        start: positionToPoint(buffer.text, d.range.start),
        message: d.message,
        severity: d.severity ?? 1,
        source: d.source,
      })
    }
  }
  return out
}

function gotoDiagnostic(editor: Editor, buffer: BufferModel, n: number, filter: number[] | null): void {
  const forward = n > 0
  const wrap = getCustom<boolean>("flymake-wrap-around") ?? true
  let diags = bufferDiagnostics(editor, buffer)
  if (filter) diags = diags.filter(d => filter.includes(d.severity))
  diags.sort((a, b) => forward ? a.start - b.start : b.start - a.start)

  const tail = diags.filter(d => forward ? d.start > buffer.point : d.start < buffer.point)
  const chain = wrap && diags.length ? [...tail, ...diags] : tail
  const target = chain[Math.abs(n) - 1]

  if (!target) {
    const suffix = filter ? ` of ${filter.map(severityLabel).join(", ")} severity` : ""
    editor.message(`No more Flymake diagnostics${suffix}`)
    return
  }
  buffer.point = target.start
  const prefix = target.source ? `${target.source} ` : ""
  editor.message(`${prefix}[${severityLabel(target.severity)}]: ${echoLine(target.message)}`)
}

function diagLocation(path: string, d: LspDiagnostic): ErrorLocation {
  return {
    file: path,
    line: d.range.start.line + 1,
    col: d.range.start.character + 1,
    text: `[${severityLabel(d.severity ?? 1)}] ${echoLine(d.message)}`,
  }
}

export function bufferDiagnosticLocations(editor: Editor, buffer: BufferModel): ErrorLocation[] {
  const lsp = editor.lsp
  if (!lsp || !buffer.path) return []
  const out: ErrorLocation[] = []
  for (const ws of lsp.bufferWorkspaces(buffer)) {
    for (const d of ws.diagnosticsByPath.get(buffer.path) ?? []) out.push(diagLocation(buffer.path, d))
  }
  return out.sort((a, b) => a.line - b.line || a.col - b.col)
}

export function projectDiagnosticLocations(editor: Editor): ErrorLocation[] {
  const lsp = editor.lsp
  if (!lsp) return []
  const seen = new Set<string>()
  const out: ErrorLocation[] = []
  for (const ws of lsp.workspaces) {
    for (const [path, diags] of ws.diagnosticsByPath) {
      for (const d of diags) {
        const key = `${path}:${d.range.start.line}:${d.range.start.character}:${d.message}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push(diagLocation(path, d))
      }
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col)
}

function showDiagnostics(editor: Editor, name: string, locations: ErrorLocation[], root: string): BufferModel | null {
  if (!locations.length) {
    editor.message("No Flymake diagnostics")
    return null
  }
  setLocationList(editor, locations)
  const lines = locations.map(l => `${relative(root, l.file)}:${l.line}:${l.col}: ${l.text}`)
  const buf = editor.scratch(name, lines.join("\n") + "\n", "flymake-diagnostics")
  buf.readOnly = true
  buf.locals.set("default-directory", root)
  buf.locals.set("next-error-locations", locations)
  editor.message(`${locations.length} diagnostic${locations.length === 1 ? "" : "s"}`)
  return buf
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  const keymap = new Keymap("flymake-diagnostics-map")
  keymap.bind("enter", "compile-goto-error")
  keymap.bind("return", "compile-goto-error")
  keymap.bind("C-m", "compile-goto-error")
  defineMode({ name: "flymake-diagnostics", parent: "text", keymap })

  editor.command("flymake-goto-next-error", ({ editor, buffer, prefixArgument }) => {
    gotoDiagnostic(editor, buffer, 1, prefixArgument != null ? [1, 2] : null)
  }, "Go to the next Flymake diagnostic.")

  editor.command("flymake-goto-prev-error", ({ editor, buffer, prefixArgument }) => {
    gotoDiagnostic(editor, buffer, -1, prefixArgument != null ? [1, 2] : null)
  }, "Go to the previous Flymake diagnostic.")

  editor.command("flymake-show-buffer-diagnostics", ({ editor, buffer }) => {
    const root = buffer.directory() ?? process.cwd()
    showDiagnostics(editor, `*Flymake diagnostics for ${buffer.name}*`,
      bufferDiagnosticLocations(editor, buffer), root)
  }, "List all Flymake diagnostics for the current buffer; RET visits one.")

  editor.command("flymake-show-project-diagnostics", ({ editor }) => {
    const root = editor.lsp?.workspaces[0]?.root ?? process.cwd()
    showDiagnostics(editor, "*Flymake diagnostics for project*",
      projectDiagnosticLocations(editor), root)
  }, "List Flymake diagnostics across all LSP workspaces; RET visits one.")

  editor.key("M-n", "flymake-goto-next-error")
  editor.key("M-p", "flymake-goto-prev-error")
}
