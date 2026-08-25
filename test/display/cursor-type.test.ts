/**
 * `cursor-type` = box: the GUI/web caret becomes a block instead of a bar.
 *
 * Char-grid hosts always paint U+2588, so the custom only has to reach the hosts
 * that draw their own caret: the layout must ship `cursor.shape` and
 * `renderCaret` must widen the element and mark it `.block` (which is what the
 * stylesheet turns into a filled, non-blinking box).
 */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { Editor } from "../../src/kernel/editor"
import { installDefaultConfig } from "../../src/config"
import { installDefaultModes } from "../../src/modes/default-modes"
import { buildDisplayModel } from "../../src/display/build-display-model"
import { buildLogicalModel } from "../../src/display/logical"
import { webLayout } from "../../src/web/web-layout"
import { setCustom } from "../../src/runtime/custom"

const GUI = { unit: "pixels", mouse: true, clipboard: true, osc52: false, perFaceFonts: true } as const
const TUI = { unit: "cells", mouse: true, clipboard: true, osc52: false } as const

function guiPaneCursor(editor: Editor) {
  const model = buildDisplayModel(editor, {
    lastMessage: "",
    viewport: { rows: 24, cols: 80 },
    hostCapabilities: { ...GUI },
  })
  return model.windows.kind === "leaf" ? model.windows.pane.cursor : undefined
}

beforeEach(() => {
  installDefaultModes()
})

afterEach(() => {
  setCustom("cursor-type", "bar")
})

test("cursor-type box marks the caret as a box for font-metric hosts", () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  const buffer = editor.scratch("cursor-box", "hello world\n", "text")
  buffer.point = 3

  setCustom("cursor-type", "bar")
  expect(guiPaneCursor(editor)).toEqual({ row: 0, colOffset: 3 })

  setCustom("cursor-type", "box")
  expect(guiPaneCursor(editor)).toEqual({ row: 0, colOffset: 3, shape: "box" })
})

test("cursor-type box does not change the char-grid block glyph path", () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  const buffer = editor.scratch("cursor-box-tui", "hello world\n", "text")
  buffer.point = 3
  setCustom("cursor-type", "box")

  const model = buildDisplayModel(editor, {
    lastMessage: "",
    viewport: { rows: 24, cols: 80 },
    hostCapabilities: { ...TUI },
  })
  const pane = model.windows.kind === "leaf" ? model.windows.pane : null
  // TUI hosts paint the glyph inline and get no `cursor` coordinate at all.
  expect(pane!.cursor).toBeUndefined()
  expect(pane!.body.chunks.map(c => c.text).join("")).toContain("\u2588")
})

test("webLayout carries the shape to the browser host", () => {
  const editor = new Editor()
  installDefaultConfig(editor)
  const buffer = editor.scratch("cursor-box-web", "hello world\n", "text")
  buffer.point = 3
  setCustom("cursor-type", "box")

  const model = webLayout(buildLogicalModel(editor), { rows: 24 })
  const pane = model.windows.kind === "leaf" ? model.windows.pane : null
  expect(pane!.cursor?.shape).toBe("box")
})

test("renderCaret draws a wide .block element for a box cursor", async () => {
  const window = new Window({ url: "http://localhost" })
  const globals = globalThis as Record<string, unknown>
  // Other suites in the same bun process install their own DOM globals; capture
  // and restore them so this test cannot leak a happy-dom window into theirs.
  const saved = {
    window: globals.window,
    document: globals.document,
    HTMLElement: globals.HTMLElement,
    requestAnimationFrame: globals.requestAnimationFrame,
  }
  globals.window = window
  globals.document = window.document
  globals.HTMLElement = window.HTMLElement
  globals.requestAnimationFrame = undefined

  try {
    const { renderCaret, renderBodyRows } = await import("../../src/display/dom-frame")
    const el = window.document.createElement("div") as unknown as HTMLElement
    window.document.body.appendChild(el as never)

    const text = { chunks: [{ text: "hello world" }] }
    const bar = renderBodyRows(el, text as never)
    renderCaret(el, bar, { row: 0, colOffset: 3 })
    const barEl = el.querySelector(".jemacs-caret") as HTMLElement
    expect(barEl.className).not.toContain("block")
    const barWidth = Number.parseFloat(barEl.style.width)

    el.replaceChildren()
    const box = renderBodyRows(el, text as never)
    renderCaret(el, box, { row: 0, colOffset: 3, shape: "box" })
    const boxEl = el.querySelector(".jemacs-caret") as HTMLElement
    expect(boxEl.className).toContain("block")
    // happy-dom reports zero-width rects, so the box falls back to a fraction of
    // the font size -- still several times wider than the bar's 1/8.
    expect(Number.parseFloat(boxEl.style.width)).toBeGreaterThan(barWidth)
  } finally {
    Object.assign(globals, saved)
  }
})
