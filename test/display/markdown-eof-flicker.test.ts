/**
 * Reproduces the reported flicker in a large markdown buffer near end-of-file.
 *
 * Markdown is the worst case for viewport convergence: headings are face-remapped to a
 * larger height, so a logical line can cost more than one visual row, and visual-fill
 * plus `word-wrap` make the cost depend on the wrap width too. `buildDisplayModel`
 * persists a corrected `startLine` after every frame, and `layoutCharGrid` derives the
 * same correction independently for rendering. If those two disagree -- or if the
 * correction is not a fixed point -- each present schedules another present and the pane
 * ping-pongs between two scroll positions with no user input.
 *
 * `startline-convergence.test.ts` covers plain `text` buffers, which have unit row costs
 * and no display filter. This file covers the markdown path specifically.
 */
import { describe, expect, test } from "bun:test"
import { buildDisplayModel } from "../../src/display/build-display-model"
import { install as installMarkdown } from "../../plugins/markdown"
import { findPaneInModel } from "../../src/display/find-pane"
import { makeEditor } from "../plugins/helper"
import type { Editor } from "../../src/kernel/editor"

const NL = String.fromCharCode(10)

const CAPS_GUI = {
  unit: "pixels" as const,
  mouse: true,
  clipboard: true,
  osc52: false,
  richTables: true,
  webSurfaces: true,
  perFaceFonts: true,
}

function startLineOf(editor: Editor): number {
  return editor.selectedWindowLeaf()?.startLine ?? 0
}

/** A document with the mix that makes row costs non-uniform: headings (taller
 *  rows), long prose paragraphs (wrapped rows), and fenced code (fixed pitch). */
function markdownDocument(sections: number): string {
  const out: string[] = []
  for (let i = 0; i < sections; i++) {
    out.push(`# Heading ${i}`)
    out.push("")
    out.push(`Prose paragraph ${i}. ` + "word ".repeat(40).trim())
    out.push("")
    out.push("## Subheading " + i)
    out.push("")
    out.push("- bullet one with a reasonably long tail of text to encourage wrapping")
    out.push("- bullet two")
    out.push("")
    out.push("```ts")
    out.push(`const value${i} = ${i}`)
    out.push("```")
    out.push("")
  }
  return out.join(NL)
}

function markdownBuffer(editor: Editor, sections: number, mode = "markdown") {
  installMarkdown(editor)
  const buffer = editor.scratch("big.md", markdownDocument(sections), mode)
  editor.switchToBuffer(buffer.id)
  return buffer
}

/** Render `frames` times and collect the persisted startLine after each. */
function startLineSeries(editor: Editor, frames: number, rows: number, cols = 120): number[] {
  const seen: number[] = []
  for (let i = 0; i < frames; i++) {
    buildDisplayModel(editor, {
      viewport: { rows, cols },
      hostCapabilities: CAPS_GUI,
    })
    seen.push(startLineOf(editor))
  }
  return seen
}

/** The body text the user actually sees, frame by frame. */
function bodySeries(editor: Editor, frames: number, rows: number, cols = 120): string[] {
  const seen: string[] = []
  for (let i = 0; i < frames; i++) {
    const model = buildDisplayModel(editor, {
      viewport: { rows, cols },
      hostCapabilities: CAPS_GUI,
    })
    const pane = findPaneInModel(model.windows, editor.selectedWindowId)
    seen.push(pane?.body.chunks.map(chunk => chunk.text).join("") ?? "")
  }
  return seen
}

describe("markdown viewport converges near end of file", () => {
  test("point at the very end settles to one startLine", () => {
    const editor = makeEditor()
    const buffer = markdownBuffer(editor, 60)
    buffer.point = buffer.text.length

    const series = startLineSeries(editor, 10, 40)
    expect(new Set(series.slice(1)).size).toBe(1)
  })

  test("the rendered body is identical on every frame at end of file", () => {
    const editor = makeEditor()
    const buffer = markdownBuffer(editor, 60)
    buffer.point = buffer.text.length

    // Let the first frame apply its correction, then demand stability.
    bodySeries(editor, 1, 40)
    const bodies = bodySeries(editor, 6, 40)
    expect(new Set(bodies).size).toBe(1)
  })

  test("settles for a range of viewport heights and widths", () => {
    const unstable: Array<{ rows: number; cols: number; series: number[] }> = []
    for (const rows of [12, 18, 24, 30, 40, 55]) {
      for (const cols of [80, 100, 120, 160]) {
        const editor = makeEditor()
        const buffer = markdownBuffer(editor, 40)
        buffer.point = buffer.text.length
        const series = startLineSeries(editor, 6, rows, cols)
        if (new Set(series.slice(1)).size !== 1) unstable.push({ rows, cols, series })
      }
    }
    expect(unstable).toEqual([])
  })

  test("settles at every point in the last screenful", () => {
    const editor = makeEditor()
    const buffer = markdownBuffer(editor, 40)
    const lineStarts = buffer.text.split(NL).length
    const unstable: Array<{ line: number; series: number[] }> = []
    for (let line = Math.max(0, lineStarts - 40); line < lineStarts; line++) {
      buffer.point = buffer.lineStarts[line] ?? buffer.text.length
      const series = startLineSeries(editor, 5, 30)
      if (new Set(series.slice(1)).size !== 1) unstable.push({ line, series })
    }
    expect(unstable).toEqual([])
  })

  test("view mode (hidden markup) settles at end of file", () => {
    const editor = makeEditor()
    const buffer = markdownBuffer(editor, 40, "markdown-view-mode")
    buffer.point = buffer.text.length

    const series = startLineSeries(editor, 8, 30)
    expect(new Set(series.slice(1)).size).toBe(1)
  })
})
