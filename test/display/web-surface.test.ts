import { afterEach, describe, expect, test } from "bun:test"
import { buildDisplayModel } from "../../src/display/build-display-model"
import { findPaneInModel } from "../../src/display/find-pane"
import { serializeDisplayModel } from "../../src/display/serialize"
import { defineMode, modes, type WebSurfaceModel } from "../../src/modes/mode"
import type { HostCapabilities } from "../../src/display/protocol"
import { makeEditor } from "../plugins/helper"

const MODE = "web-surface-probe"
/**
 * Two lines because the selected window paints a cursor glyph over the first character
 * of line one; assertions therefore read line two, which renders verbatim.
 */
const BODY = ["PASS  probe.testOne", "FAIL  probe.testTwo"].join(String.fromCharCode(10))

/** A GUI host: renders rich panes. Mirrors `ElectronHost.capabilities`. */
const guiHost: HostCapabilities = {
  unit: "pixels",
  mouse: true,
  clipboard: true,
  osc52: false,
  richTables: true,
  webSurfaces: true,
}

/** A terminal host: no DOM, so no rich panes. Mirrors the OpenTUI host. */
const tuiHost: HostCapabilities = {
  unit: "cells",
  mouse: true,
  clipboard: true,
  osc52: true,
}

const surface: WebSurfaceModel = {
  kind: "web",
  nodes: [
    { kind: "row", id: "probe.testTwo", action: "rerun", children: [{ kind: "text", text: "FAIL", face: "error" }] },
    { kind: "bar", value: 0.5, text: "1.0s", face: "success" },
  ],
  canvas: { aspect: 3, shapes: [{ kind: "rect", x: 0, y: 0, width: 1, height: 0.5, face: "success" }] },
}

function paneFor(capabilities: HostCapabilities, webSurface: () => WebSurfaceModel | null) {
  defineMode({ name: MODE, parent: "text", webSurface })
  const editor = makeEditor()
  const buffer = editor.scratch("*probe*", BODY, MODE, false)
  editor.switchToBuffer(buffer.id)
  const model = buildDisplayModel(editor, { viewport: { rows: 24, cols: 80 }, hostCapabilities: capabilities })
  return { editor, buffer, model, pane: findPaneInModel(model.windows, editor.selectedWindowId) }
}

afterEach(() => { modes.delete(MODE) })

describe("web surface plumbing", () => {
  test("reaches a GUI pane with its nodes and canvas intact", () => {
    const { pane } = paneFor(guiHost, () => surface)
    expect(pane?.webSurface?.kind).toBe("web")
    expect(pane?.webSurface?.nodes[0]?.action).toBe("rerun")
    expect(pane?.webSurface?.canvas?.shapes).toHaveLength(1)
  })

  test("is withheld from a terminal host, which falls back to the body text", () => {
    // This is the guarantee that makes every web-surface feature TUI-compatible: the
    // host simply never sees the surface, and `body` is always populated regardless.
    const { pane } = paneFor(tuiHost, () => surface)
    expect(pane?.webSurface).toBeUndefined()
    expect(pane?.body.chunks.map(chunk => chunk.text).join("")).toContain("FAIL  probe.testTwo")
  })

  test("the GUI pane keeps the same body text as the terminal one", () => {
    // The rich pane is a rendering of the body, never a replacement for it, so copying
    // and searching keep working in the GUI.
    const gui = paneFor(guiHost, () => surface)
    const tui = paneFor(tuiHost, () => surface)
    const bodyOf = (pane: typeof gui.pane) => pane?.body.chunks.map(chunk => chunk.text).join("")
    expect(bodyOf(gui.pane)).toBe(bodyOf(tui.pane))
  })

  test("a mode returning null renders as plain text", () => {
    const { pane } = paneFor(guiHost, () => null)
    expect(pane?.webSurface).toBeUndefined()
    expect(pane?.body.chunks.map(chunk => chunk.text).join("")).toContain("FAIL  probe.testTwo")
  })

  test("a throwing mode degrades to text instead of taking the frame down", () => {
    const { pane } = paneFor(guiHost, () => { throw new Error("surface exploded") })
    expect(pane?.webSurface).toBeUndefined()
    expect(pane?.body.chunks.map(chunk => chunk.text).join("")).toContain("FAIL  probe.testTwo")
  })

  test("survives serialization to the renderer as a deep copy", () => {
    const { model } = paneFor(guiHost, () => surface)
    const serialized = serializeDisplayModel(model)
    const pane = serialized.windows.kind === "leaf" ? serialized.windows.pane : undefined
    expect(pane?.webSurface?.nodes[1]).toMatchObject({ kind: "bar", value: 0.5, text: "1.0s" })
    expect(pane?.webSurface?.canvas?.aspect).toBe(3)
    // A deep copy, so a mode mutating its model cannot corrupt the host's diff baseline.
    expect(pane?.webSurface?.nodes).not.toBe(surface.nodes)
    expect(pane?.webSurface?.canvas?.shapes[0]).not.toBe(surface.canvas!.shapes[0])
  })
})
