import type { BufferModel } from "../../src/kernel/buffer"

/**
 * Indentation-based code folding, the behaviour `yafolding` provides in Emacs.
 *
 * Folding is derived from indentation rather than syntax so it works in every language
 * without a per-mode parser -- which is exactly the tradeoff yafolding makes.
 */

/** Buffer-local key holding the set of folded start lines. */
export const FOLDED_LINES = "yafolding-folded-lines"

/** Leading-whitespace width, or null for a blank line (which has no meaningful indent). */
export function indentOf(line: string): number | null {
  if (!line.trim()) return null
  const match = /^[ \t]*/.exec(line)
  return match ? match[0].replace(/\t/g, "        ").length : 0
}

/**
 * The range of lines belonging to the element starting at `startLine`.
 *
 * Returns `[startLine, endLine]` inclusive, where `endLine` is the last line indented
 * more deeply than the start. Blank lines are absorbed only when more content follows at
 * depth, so a fold does not swallow the gap between two top-level definitions.
 */
export function elementRange(lines: string[], startLine: number): [number, number] | null {
  const baseIndent = indentOf(lines[startLine] ?? "")
  if (baseIndent == null) return null

  let end = startLine
  for (let i = startLine + 1; i < lines.length; i++) {
    const indent = indentOf(lines[i] ?? "")
    if (indent == null) continue
    if (indent <= baseIndent) break
    end = i
  }
  return end > startLine ? [startLine, end] : null
}

/** Line index containing `point`. */
export function lineIndexAt(buffer: BufferModel, point = buffer.point): number {
  let line = 0
  const limit = Math.min(point, buffer.text.length)
  for (let i = 0; i < limit; i++) if (buffer.text[i] === "\n") line++
  return line
}

export function foldedLines(buffer: BufferModel): Set<number> {
  const existing = buffer.locals.get(FOLDED_LINES)
  if (existing instanceof Set) return existing as Set<number>
  const created = new Set<number>()
  buffer.locals.set(FOLDED_LINES, created)
  return created
}

/**
 * Build the folded rendering of `text`.
 *
 * Returns the display text plus the offset maps `Mode.displayFilter` requires: `map`
 * converts a buffer offset to a display offset and `unmap` reverses it, so point and
 * search keep working while lines are hidden.
 */
export function foldDisplay(
  text: string,
  folded: ReadonlySet<number>,
): { text: string; map: (n: number) => number; unmap: (n: number) => number } | null {
  if (folded.size === 0) return null

  const lines = text.split("\n")
  const hidden = new Set<number>()
  for (const start of folded) {
    const range = elementRange(lines, start)
    if (!range) continue
    for (let i = range[0] + 1; i <= range[1]; i++) hidden.add(i)
  }
  if (hidden.size === 0) return null

  // Offsets of each line start in the source, for building the offset maps.
  const sourceStarts: number[] = []
  let offset = 0
  for (const line of lines) {
    sourceStarts.push(offset)
    offset += line.length + 1
  }

  const out: string[] = []
  // Parallel arrays: for each emitted line, its source line index and display offset.
  const emittedSourceLine: number[] = []
  const emittedDisplayStart: number[] = []
  let displayOffset = 0

  for (let i = 0; i < lines.length; i++) {
    if (hidden.has(i)) continue
    const suffix = folded.has(i) && elementRange(lines, i) ? " …" : ""
    const rendered = lines[i] + suffix
    emittedSourceLine.push(i)
    emittedDisplayStart.push(displayOffset)
    out.push(rendered)
    displayOffset += rendered.length + 1
  }

  const displayText = out.join("\n")

  const map = (n: number): number => {
    const clamped = Math.max(0, Math.min(n, text.length))
    // Find the source line containing `clamped`.
    let line = 0
    while (line + 1 < sourceStarts.length && sourceStarts[line + 1]! <= clamped) line++
    // Walk back to the nearest visible ancestor when the line itself is hidden.
    let visible = line
    while (visible > 0 && hidden.has(visible)) visible--
    const slot = emittedSourceLine.indexOf(visible)
    if (slot === -1) return 0
    const column = hidden.has(line) ? 0 : clamped - sourceStarts[line]!
    return Math.min(emittedDisplayStart[slot]! + column, displayText.length)
  }

  const unmap = (n: number): number => {
    const clamped = Math.max(0, Math.min(n, displayText.length))
    let slot = 0
    while (slot + 1 < emittedDisplayStart.length && emittedDisplayStart[slot + 1]! <= clamped) slot++
    const sourceLine = emittedSourceLine[slot] ?? 0
    const column = clamped - (emittedDisplayStart[slot] ?? 0)
    const lineLength = lines[sourceLine]?.length ?? 0
    return sourceStarts[sourceLine]! + Math.min(column, lineLength)
  }

  return { text: displayText, map, unmap }
}
