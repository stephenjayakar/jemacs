/**
 * tmux-cc GUI judder.
 *
 * `layoutLeafPane` ran every terminal pane through `activeTerminalSurface`,
 * which returned undefined unless the surface's grid matched the pane's
 * computed body geometry exactly. On any resize or layout change the kernel
 * stamps the new geometry immediately, but the emulator behind the pane
 * catches up asynchronously -- tmux-cc debounces its `refreshGeometry` by
 * 50ms, and `JTermSession.resize` only then reshapes the headless xterm.
 *
 * For the duration of that gap the pane fell out of the terminal branch
 * entirely: `terminalSurface` went undefined, the modeline reverted from
 * `terminalModeline` to `modeline`, and the Electron renderer -- which only
 * calls `XtermPaneRegistry.mount()` when `terminalSurface` is present --
 * abandoned the live xterm.js instance to draw themed text spans, then popped
 * back once the resize landed. That render-engine swap is the judder.
 *
 * Raw-stream hosts own their emulator and consume the surface as shape-only
 * metadata, so a momentarily stale grid is harmless. They now keep the
 * terminal branch across the gap. Hosts that paint the grid from the model's
 * cells still require an exact fit.
 *
 * The metadata deliberately keeps reporting the *emulator's* dimensions rather
 * than the pane's budget: raw-stream hosts key their terminal by `bufferId`, so
 * one buffer in two windows shares a single emulator and per-pane budgets would
 * make the panes fight over its size every frame.
 */
import { expect, test } from "bun:test"
import { buildDisplayModel } from "../../src/display/build-display-model"
import { TERMINAL_SURFACE_LOCAL, type TerminalSurfaceModel } from "../../src/display/terminal-surface"
import { themedTextPlain } from "../../src/display/themed-text"
import { Editor } from "../../src/kernel/editor"
import { installDefaultConfig } from "../../src/config"
import { installDefaultModes } from "../../src/modes/default-modes"
import type { HostCapabilities } from "../../src/display/protocol"
import type { WindowSplit } from "../../src/kernel/window"

const rawHost: HostCapabilities = {
  unit: "pixels",
  mouse: true,
  clipboard: true,
  osc52: false,
  terminalSurfaces: true,
  terminalRawStreams: true,
}

const gridHost: HostCapabilities = { ...rawHost, terminalRawStreams: false }

// Mode registration is global; do it once rather than per-test.
installDefaultModes()

function surface(rows: number, cols: number): TerminalSurfaceModel {
  return {
    kind: "terminal",
    rows,
    cols,
    cursorRow: 0,
    cursorCol: 0,
    cells: Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ text: "x" }))),
  }
}

/** One editor reused across the single-window cases. Constructing an Editor is
 *  the expensive part of this file, and enough of it is synchronous that doing
 *  it per test measurably delays timers other test files schedule on the real
 *  clock (auto-revert's file-watch poll, eldoc's idle timer). */
let shared: Editor | undefined
function sharedEditor(): Editor {
  if (!shared) {
    shared = new Editor()
    installDefaultConfig(shared)
  }
  return shared
}

/** Build a one-window frame whose terminal buffer carries `stale` dimensions. */
function paneFor(stale: TerminalSurfaceModel | undefined, host: HostCapabilities, rows = 24) {
  const editor = sharedEditor()
  const buffer = editor.scratch("tmux-pane", "", "text")
  buffer.locals.delete(TERMINAL_SURFACE_LOCAL)
  if (stale) buffer.locals.set(TERMINAL_SURFACE_LOCAL, stale)
  const model = buildDisplayModel(editor, {
    lastMessage: "",
    viewport: { rows, cols: 80 },
    hostCapabilities: host,
  })
  const pane = model.windows.kind === "leaf" ? model.windows.pane : null
  expect(pane).not.toBeNull()
  const budget = pane!.bodyLineBudget
  return { pane: pane!, budget }
}

test("raw-stream host keeps the terminal branch while the emulator lags a resize", () => {
  // Sanity: an exactly-fitting surface establishes the pane's body budget.
  const fitted = paneFor(surface(20, 80), rawHost)
  expect(fitted.pane.terminalSurface).toBeDefined()

  // Now the same pane with a surface still shaped to the *previous* layout,
  // exactly what tmux-cc's 50ms geometry debounce leaves on screen.
  const stale = paneFor(surface(Math.max(1, fitted.budget - 7), 40), rawHost)
  expect(stale.pane.terminalSurface).toBeDefined()
  // Under the bug this fell through to the text path and rendered the mirror.
  expect(themedTextPlain(stale.pane.body)).toBe("")
})

test("raw-stream metadata reports emulator shape with no cells", () => {
  const { pane } = paneFor(surface(3, 12), rawHost)
  // Must be the emulator's own dimensions -- see the split test below for why
  // reporting the pane budget here is actively harmful.
  expect(pane.terminalSurface).toMatchObject({ rows: 3, cols: 12 })
  // Raw hosts stream cells over their own channel; the model stays empty.
  expect(pane.terminalSurface?.cells).toEqual([])
})

test("one buffer in two windows reports one agreed size to the raw host", async () => {
  // XtermPaneRegistry keys its Terminal by bufferId, so both leaves below are
  // backed by a single xterm instance. If each pane reported its own row
  // budget, mount() would resize that shared instance twice per frame, forever
  // -- a permanent thrash strictly worse than the transient this file fixes.
  const editor = new Editor()
  installDefaultConfig(editor)
  const buffer = editor.scratch("tmux-pane", "", "text")
  buffer.locals.set(TERMINAL_SURFACE_LOCAL, surface(9, 40))
  await editor.run("split-window-below")
  ;(editor.windowLayout as WindowSplit).firstRatio = 0.75
  const model = buildDisplayModel(editor, {
    lastMessage: "",
    viewport: { rows: 30, cols: 80 },
    hostCapabilities: rawHost,
  })
  expect(model.windows.kind).toBe("split")
  if (model.windows.kind !== "split") return
  const first = model.windows.first.kind === "leaf" ? model.windows.first.pane : null
  const second = model.windows.second.kind === "leaf" ? model.windows.second.pane : null
  // Same buffer, so same emulator, so the two panes must agree.
  expect(first?.bufferId).toBe(second!.bufferId)
  expect(first?.terminalSurface).toEqual(second!.terminalSurface!)
})

test("raw-stream metadata is stable when the pane has no column budget", () => {
  // viewport.cols undefined (the surface's own cols must survive, not collapse
  // onto some unrelated fallback).
  const editor = new Editor()
  installDefaultConfig(editor)
  const buffer = editor.scratch("tmux-pane", "", "text")
  buffer.locals.set(TERMINAL_SURFACE_LOCAL, surface(7, 64))
  const model = buildDisplayModel(editor, {
    lastMessage: "",
    viewport: { rows: 24 },
    hostCapabilities: rawHost,
  })
  const pane = model.windows.kind === "leaf" ? model.windows.pane : null
  expect(pane?.terminalSurface).toMatchObject({ rows: 7, cols: 64 })
})

test("grid-rendering hosts still require an exact fit", () => {
  // These hosts paint the cells straight from the model, so a stale grid would
  // draw at the wrong size. Falling back to text is correct for them.
  const { pane } = paneFor(surface(3, 12), gridHost)
  expect(pane.terminalSurface).toBeUndefined()
})

test("grid-rendering hosts render a fitting surface from the model cells", () => {
  const fitted = paneFor(surface(20, 80), gridHost)
  expect(fitted.pane.terminalSurface).toBeDefined()
  expect(fitted.pane.terminalSurface?.cells.length).toBeGreaterThan(0)
})

test("no surface at all still falls back to text on every host", () => {
  // jterm's copy-mode deletes the local outright; that fallback must survive.
  expect(paneFor(undefined, rawHost).pane.terminalSurface).toBeUndefined()
  expect(paneFor(undefined, gridHost).pane.terminalSurface).toBeUndefined()
})
