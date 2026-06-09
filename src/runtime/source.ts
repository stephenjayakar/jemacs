import { resolve } from "node:path"
import type { CommandSpec } from "../kernel/command"
import type { Editor } from "../kernel/editor"
import { positionToPoint } from "../lsp/positions"
import { definitionRefFromForm } from "./definitions"

export type SourceLocation = {
  file: string
  line: number
  column?: number
}

const INTERNAL_STACK = /[/\\](?:kernel|runtime)[/\\](?:editor|command)\.ts:/

export function captureCallerSource(skipFrames = 2): SourceLocation | undefined {
  const stack = new Error().stack?.split("\n") ?? []
  for (const line of stack.slice(skipFrames)) {
    const match = line.match(/\(([^)]+):(\d+):(\d+)\)$/) ?? line.match(/at ([^ ]+):(\d+):(\d+)$/)
    if (!match) continue
    const file = match[1]!
    if (INTERNAL_STACK.test(`${file}:`)) continue
    if (file.includes("node:internal")) continue
    return { file: resolve(file), line: Number(match[2]), column: Number(match[3]) }
  }
  return undefined
}

export function formatSourceLine(source: SourceLocation): string {
  const col = source.column != null ? `:${source.column}` : ""
  return `Source: ${source.file}:${source.line}${col}`
}

export function parseSourceLineAtPoint(text: string, point: number): SourceLocation | null {
  const lineStart = text.lastIndexOf("\n", point - 1) + 1
  const lineEnd = text.indexOf("\n", point)
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd)
  const match = line.match(/^Source:\s+(.+?):(\d+)(?::(\d+))?\s*$/)
  if (!match) return null
  return { file: resolve(match[1]!), line: Number(match[2]), column: match[3] ? Number(match[3]) : undefined }
}

export function formatDescribeFunction(spec: CommandSpec): string {
  const lines = [spec.name, ""]
  if (spec.description) lines.push(spec.description, "")
  if (spec.source) {
    lines.push(formatSourceLine(spec.source))
    lines.push("RET here — find-function (visit and edit source)")
    lines.push("")
  } else {
    lines.push("Source: unknown (defined without editor.command or eval)")
    lines.push("")
  }
  if (spec.patched) {
    lines.push("Status: temporarily patched (M-x jemacs-revert-function restores baseline)")
    lines.push("")
  }
  const body = String(spec.fn)
  const preview = body.length > 1200 ? `${body.slice(0, 1200)}\n…` : body
  lines.push("Implementation:", preview)
  return lines.join("\n")
}

export async function visitSource(editor: Editor, source: SourceLocation): Promise<void> {
  const buffer = await editor.openFile(source.file)
  buffer.point = positionToPoint(buffer.text, { line: source.line - 1, character: source.column ?? 0 })
  await editor.changed("find-function")
}

export function extractTopLevelForm(text: string, point: number): { start: number; end: number; text: string } | null {
  const anchor = findFormAnchor(text, point)
  if (anchor == null) return null
  const scanStart = text[anchor] === "(" ? anchor : text.indexOf("(", anchor)
  if (scanStart < 0) return null
  const end = scanBalancedForm(text, scanStart)
  if (end == null) return null
  return { start: anchor, end, text: text.slice(anchor, end) }
}

export function commandNameFromForm(form: string): string | null {
  return definitionRefFromForm(form)?.name ?? null
}


function findFormAnchor(text: string, point: number): number | null {
  const before = text.slice(0, point)
  const commandIdx = before.lastIndexOf("editor.command")
  if (commandIdx >= 0 && commandIdx <= point) return commandIdx
  const exportIdx = before.lastIndexOf("export ")
  if (exportIdx >= 0) return exportIdx
  const fnIdx = before.lastIndexOf("function ")
  if (fnIdx >= 0) return fnIdx
  const asyncIdx = before.lastIndexOf("async ")
  if (asyncIdx >= 0) return asyncIdx
  const lineStart = before.lastIndexOf("\n") + 1
  return lineStart
}

function scanBalancedForm(text: string, start: number): number | null {
  let depth = 0
  let quote: "'" | '"' | "`" | null = null
  let escaped = false
  let i = start
  for (; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === "\\") {
        escaped = true
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch
      continue
    }
    if (ch === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i)
      if (i === -1) return text.length
      continue
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2)
      i = end === -1 ? text.length : end + 1
      continue
    }
    if (ch === "(" || ch === "{" || ch === "[") {
      depth++
      continue
    }
    if (ch === ")" || ch === "}" || ch === "]") {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return null
}
