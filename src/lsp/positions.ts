import { pathToFileURL } from "node:url"
import { resolve } from "node:path"
import type { BufferModel } from "../kernel/buffer"

export type LspPosition = { line: number; character: number }
export type LspRange = { start: LspPosition; end: LspPosition }

/** file:// URI (lsp--path-to-uri). */
export function pathToUri(path: string): string {
  return pathToFileURL(resolve(path)).href
}

export function uriToPath(uri: string): string {
  if (uri.startsWith("file://")) return decodeURIComponent(new URL(uri).pathname)
  return uri
}

/** 0-based line, UTF-16 code unit character (lsp--cur-position). */
export function pointToPosition(text: string, point: number): LspPosition {
  const clamped = Math.max(0, Math.min(point, text.length))
  const before = text.slice(0, clamped)
  const lines = before.split("\n")
  const line = lines.length - 1
  const lineStart = before.lastIndexOf("\n") + 1
  const character = before.slice(lineStart).length
  return { line, character }
}

export function positionToPoint(text: string, position: LspPosition): number {
  const lines = text.split("\n")
  const line = Math.max(0, Math.min(position.line, lines.length - 1))
  let offset = 0
  for (let i = 0; i < line; i++) offset += lines[i]!.length + 1
  const lineText = lines[line] ?? ""
  const character = Math.max(0, Math.min(position.character, lineText.length))
  return offset + character
}

export function bufferUri(buffer: BufferModel): string | null {
  if (!buffer.path) return null
  return pathToUri(buffer.path)
}

export function bufferLanguageId(buffer: BufferModel): string {
  const mode = buffer.mode
  if (mode === "python") return "python"
  if (mode === "javascript" || mode === "typescript") return mode
  if (mode === "json") return "json"
  return mode
}
