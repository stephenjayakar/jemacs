import type { Editor } from "../kernel/editor"
import type { BufferModel } from "../kernel/buffer"
import { pointToPosition, positionToPoint } from "../lsp/positions"
import type { XrefLocation } from "./types"

export async function jumpToXrefLocation(editor: Editor, location: XrefLocation): Promise<void> {
  if (location.kind === "buffer" && location.bufferId) {
    const buffer = editor.buffers.get(location.bufferId)
    if (!buffer) return
    editor.switchToBuffer(location.bufferId)
    buffer.point = positionToPoint(buffer.text, { line: location.line, character: location.column })
    editor.setSelectedWindowPoint(buffer.point)
    await editor.changed("xref-jump")
    return
  }

  if (!location.path) return
  const buffer = await editor.openFile(location.path)
  buffer.point = positionToPoint(buffer.text, { line: location.line, character: location.column })
  editor.setSelectedWindowPoint(buffer.point)
  await editor.changed("xref-jump")
}

export function bufferSearchDefinitions(buffer: BufferModel, identifier: string): XrefLocation[] {
  if (!identifier) return []
  const patterns = definitionPatterns(buffer.mode, identifier)
  const locations: XrefLocation[] = []
  for (const pattern of patterns) {
    for (const match of buffer.text.matchAll(pattern)) {
      if (match.index == null) continue
      const pos = pointToPosition(buffer.text, match.index)
      locations.push({
        kind: "buffer",
        bufferId: buffer.id,
        line: pos.line,
        column: pos.character,
        summary: match[0].trim(),
      })
    }
  }
  return dedupeLocations(locations)
}

function definitionPatterns(mode: string, identifier: string): RegExp[] {
  const id = escapeRegex(identifier)
  if (mode === "python") {
    return [new RegExp(`^\\s*(?:async\\s+def|def|class)\\s+${id}\\b`, "gm")]
  }
  if (mode === "javascript" || mode === "typescript") {
    return [
      new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+function|function|class)\\s+${id}\\b`, "gm"),
      new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${id}\\b`, "gm"),
    ]
  }
  return [new RegExp(`^\\s*(?:def|class|function)\\s+${id}\\b`, "gm")]
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function dedupeLocations(locations: XrefLocation[]): XrefLocation[] {
  const seen = new Set<string>()
  return locations.filter(loc => {
    const key = `${loc.kind}:${loc.path ?? loc.bufferId}:${loc.line}:${loc.column}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
