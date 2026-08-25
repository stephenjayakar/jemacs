/**
 * One redisplay must build each frame exactly once, with the host's capabilities.
 *
 * The GUI regressed into two independent render paths that both painted the same OS
 * window on every `changed` event: `bindJemacsHost.present` (which passed
 * `hostCapabilities`) and a private `syncFrames` closure in `main-electron` (which did
 * not). That is a flicker generator in two distinct ways:
 *
 *   1. `layoutLeafPane` gates `webSurface` on `hostCapabilities.webSurfaces`, so the
 *      capability-less build dropped canvas-mode and html-mode panes to their plain-text
 *      fallback. The pane alternated drawing / buffer text every frame.
 *
 *   2. `buildDisplayModel` persists a corrected `startLine` onto the window as a side
 *      effect, and that correction depends on `perFaceFonts` (font-metric row costs vs
 *      unit rows). Two builds per redisplay with different capabilities wrote different
 *      corrections on alternate frames, so the viewport ping-ponged -- worst at the end
 *      of a large markdown buffer, where the clamp makes the two answers differ.
 *
 * These tests drive the real `runJemacsCore` loop through fake hosts, so they fail if
 * either path is reintroduced.
 */
import { describe, expect, test } from "bun:test"
import { runJemacsCore } from "../../src/run-core"
import { findPaneInModel } from "../../src/display/find-pane"
import { serializeDisplayModel } from "../../src/display/serialize"
import { install as installCanvas } from "../../plugins/canvas-mode"
import { install as installMarkdown } from "../../plugins/markdown"
import { DEMOS } from "../../plugins/canvas-mode/demos"
import { makeEditor } from "../plugins/helper"
import { modes } from "../../src/modes/mode"
import type { DisplayModel, HostCapabilities, UiHost } from "../../src/display/protocol"
import type { Editor } from "../../src/kernel/editor"

const NL = String.fromCharCode(10)

const GUI_CAPS: HostCapabilities = {
  unit: "pixels",
  mouse: true,
  clipboard: true,
  osc52: false,
  richTables: true,
  webSurfaces: true,
  perFaceFonts: true,
}

/** Records every model the binding builds, and how it was painted. */
type Recorder = {
  host: UiHost
  /** Models handed to `present`. */
  presented: DisplayModel[]
  /** Models built through `syncFrames`'s `render` callback. */
  rendered: DisplayModel[]
  /** Every model, in build order. */
  all: DisplayModel[]
  syncFrameCalls: number
}

function recordingHost(options: { multiFrame: boolean }): Recorder {
  const presented: DisplayModel[] = []
  const rendered: DisplayModel[] = []
  const all: DisplayModel[] = []
  const recorder = { presented, rendered, all, syncFrameCalls: 0 } as Recorder

  const host: UiHost = {
    label: "Jemacs GUI",
    capabilities: GUI_CAPS,
    async start() {},
    destroy() {},
    present(model) {
      presented.push(model)
      all.push(model)
    },
    getViewport: () => ({ rows: 40, cols: 120 }),
    onInput() {},
    onResize() {},
  }

  if (options.multiFrame) {
    host.syncFrames = (frames, render) => {
      recorder.syncFrameCalls++
      for (const frame of frames) {
        const model = render(frame.id)
        rendered.push(model)
        all.push(model)
      }
    }
  }

  recorder.host = host
  return recorder
}

/** Let the queueMicrotask-scheduled redisplay run. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))

function canvasBuffer(editor: Editor) {
  installCanvas(editor)
  const demo = DEMOS.find(d => d.name === "sine")!
  const buffer = editor.scratch("*canvas: sine*", demo.source, "canvas")
  editor.switchToBuffer(buffer.id)
  return buffer
}

function markdownBuffer(editor: Editor, sections: number) {
  installMarkdown(editor)
  const lines: string[] = []
  for (let i = 0; i < sections; i++) {
    lines.push(`# Heading ${i}`)
    lines.push("")
    lines.push(`Prose paragraph ${i}. ` + "word ".repeat(30).trim())
    lines.push("")
  }
  const buffer = editor.scratch("big.md", lines.join(NL), "markdown")
  editor.switchToBuffer(buffer.id)
  return buffer
}

function paneOf(editor: Editor, model: DisplayModel) {
  return findPaneInModel(model.windows, editor.selectedWindowId)
}

describe("one redisplay paints each frame once", () => {
  test("a multi-frame host paints through syncFrames only, never also present", async () => {
    const editor = makeEditor()
    const recorder = recordingHost({ multiFrame: true })
    await runJemacsCore(editor, recorder.host)

    await editor.changed("probe")
    await settle()

    // Painting through both paths is the bug: the same window would be built twice.
    expect(recorder.presented).toHaveLength(0)
    expect(recorder.rendered.length).toBeGreaterThan(0)
    // One frame in the editor means one model built per redisplay.
    expect(recorder.rendered).toHaveLength(recorder.syncFrameCalls * editor.frames.length)
  })

  test("a single-frame host still paints through present", async () => {
    const editor = makeEditor()
    const recorder = recordingHost({ multiFrame: false })
    await runJemacsCore(editor, recorder.host)

    await editor.changed("probe")
    await settle()

    expect(recorder.presented.length).toBeGreaterThan(0)
  })

  test("every model built by a multi-frame host carries the web surface", async () => {
    const editor = makeEditor()
    try {
      canvasBuffer(editor)
      const recorder = recordingHost({ multiFrame: true })
      await runJemacsCore(editor, recorder.host)

      for (let i = 0; i < 5; i++) {
        await editor.changed(`tick ${i}`)
        await settle()
      }

      // A single model without the surface is one frame of plain text in the middle
      // of an animation -- exactly the flash the user sees.
      const withoutSurface = recorder.all.filter(model => !paneOf(editor, model)?.webSurface)
      expect(withoutSurface).toHaveLength(0)
      expect(recorder.all.length).toBeGreaterThan(0)
    } finally {
      modes.delete("canvas")
    }
  })

  test("the viewport does not move once settled at the end of a large markdown buffer", async () => {
    const editor = makeEditor()
    const buffer = markdownBuffer(editor, 300)
    buffer.point = buffer.text.length

    const recorder = recordingHost({ multiFrame: true })
    await runJemacsCore(editor, recorder.host)

    // First redisplay applies the correction; everything after must agree.
    await editor.changed("settle")
    await settle()
    const settled = editor.selectedWindowLeaf()?.startLine

    const series: Array<number | undefined> = []
    for (let i = 0; i < 6; i++) {
      await editor.changed(`idle ${i}`)
      await settle()
      series.push(editor.selectedWindowLeaf()?.startLine)
    }

    expect(series).toEqual([settled, settled, settled, settled, settled, settled])
  })

  test("the rendered body is byte-identical across idle redisplays at end of file", async () => {
    const editor = makeEditor()
    const buffer = markdownBuffer(editor, 300)
    buffer.point = buffer.text.length

    const recorder = recordingHost({ multiFrame: true })
    await runJemacsCore(editor, recorder.host)

    await editor.changed("settle")
    await settle()
    const before = recorder.all.length

    for (let i = 0; i < 5; i++) {
      await editor.changed(`idle ${i}`)
      await settle()
    }

    const bodies = recorder.all
      .slice(before)
      .map(model => paneOf(editor, model)?.body.chunks.map(chunk => chunk.text).join(""))
    expect(bodies.length).toBeGreaterThan(0)
    // More than one distinct body with no edits and no cursor movement is flicker.
    expect(new Set(bodies).size).toBe(1)
  })

  /**
   * The whole model must be stable, not just the pane body.
   *
   * `present` passes `lastMessage` and the frame render path does not, so a second
   * build per redisplay also blanks the echo area. The renderer diffs the serialized
   * model, so an echo line that alternates between the message and empty repaints that
   * row on every frame -- the same class of bug as the pane body, one row lower.
   */
  test("the whole model is stable across idle redisplays, echo area included", async () => {
    const editor = makeEditor()
    const buffer = markdownBuffer(editor, 300)
    buffer.point = buffer.text.length

    const recorder = recordingHost({ multiFrame: true })
    await runJemacsCore(editor, recorder.host)

    editor.message("Saved big.md")
    await editor.changed("settle")
    await settle()
    const before = recorder.all.length

    for (let i = 0; i < 5; i++) {
      await editor.changed(`idle ${i}`)
      await settle()
    }

    const painted = recorder.all.slice(before)
    expect(painted.length).toBeGreaterThan(0)
    const snapshots = painted.map(model => JSON.stringify(serializeDisplayModel(model)))
    expect(new Set(snapshots).size).toBe(1)
  })
})
