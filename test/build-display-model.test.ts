import { expect, test } from "bun:test"
import { buildDisplayModel } from "../src/display/build-display-model"
import { TERMINAL_SURFACE_LOCAL, type TerminalSurfaceModel } from "../src/display/terminal-surface"
import { themedTextPlain } from "../src/display/themed-text"
import { Editor } from "../src/kernel/editor"
import { installDefaultConfig } from "../src/config"
import { installDefaultModes } from "../src/modes/default-modes"
import { composeTheme, resetFace, setFaceAttribute } from "../src/runtime/faces"
import { defaultTheme } from "../src/themes"
import { install as installOrg } from "../plugins/org"
import { install as installMarkdown } from "../plugins/markdown"

test("buildDisplayModel includes buffer name in title", () => {
  installDefaultModes()
  const editor = new Editor()
  installDefaultConfig(editor)
  editor.scratch("plan-test", "hello", "text")
  const model = buildDisplayModel(editor, {
    lastMessage: "",
    viewport: { rows: 30, cols: 80 },
    hostLabel: "Jemacs Test",
  })
  expect(themedTextPlain(model.title)).toContain("plan-test")
  expect(themedTextPlain(model.title)).toContain("Jemacs Test")
})

test("buildDisplayModel highlights isearch in selected window", async () => {
  installDefaultModes()
  const editor = new Editor()
  installDefaultConfig(editor)
  editor.scratch("isearch-test", "find me find", "text")
  await editor.run("isearch-forward")
  editor.isearch!.string = "find"
  const model = buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 30 } })
  const leaf = model.windows.kind === "leaf" ? model.windows.pane : null
  expect(leaf).not.toBeNull()
  const body = themedTextPlain(leaf!.body)
  expect(body).toContain("find")
})

test("buildDisplayModel uses theme from editor", () => {
  installDefaultModes()
  const editor = new Editor()
  editor.setTheme(defaultTheme)
  expect(buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 24 } }).theme.name)
    .toBe(defaultTheme.name)
})

test("buildDisplayModel sends terminal metadata only when host consumes raw streams", () => {
  installDefaultModes()
  const editor = new Editor()
  installDefaultConfig(editor)
  const buffer = editor.scratch("terminal", "", "text")
  const surface: TerminalSurfaceModel = {
    kind: "terminal",
    rows: 20,
    cols: 80,
    cursorRow: 0,
    cursorCol: 0,
    cells: [[{ text: "x", fg: "#ff0000" }]],
  }
  buffer.locals.set(TERMINAL_SURFACE_LOCAL, surface)

  const model = buildDisplayModel(editor, {
    lastMessage: "",
    viewport: { rows: 24, cols: 80 },
    hostCapabilities: {
      unit: "pixels",
      mouse: true,
      clipboard: true,
      osc52: false,
      terminalSurfaces: true,
      terminalRawStreams: true,
    },
  })
  const leaf = model.windows.kind === "leaf" ? model.windows.pane : null
  expect(leaf?.terminalSurface).toMatchObject({ rows: 20, cols: 80, cursorRow: 0, cursorCol: 0 })
  expect(leaf?.terminalSurface?.cells).toEqual([])
  expect(themedTextPlain(leaf!.body)).toBe("")
})

test("buildDisplayModel body chunks include customized default face font attrs", () => {
  installDefaultModes()
  const editor = new Editor()
  resetFace("default")
  setFaceAttribute("default", "family", "Fira Code")
  setFaceAttribute("default", "height", 140)
  editor.setTheme(composeTheme(defaultTheme))
  const buffer = editor.scratch("font-test", "hello", "text")
  buffer.point = buffer.text.length
  const model = buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 24, cols: 80 } })
  expect(model.theme.faces.default?.family).toBe("Fira Code")
  const leaf = model.windows.kind === "leaf" ? model.windows.pane : null
  expect(leaf).not.toBeNull()
  const styled = leaf!.body.chunks.find(chunk => chunk.text.includes("hello"))
  expect(styled?.family).toBe("Fira Code")
  expect(styled?.height).toBe(140)
  resetFace("default")
})

// t-fb6d4cdb: displayFilter is the only place a mode reshapes what reaches the
// renderer; org.test.ts covers orgDisplayFilter in isolation but nothing drove
// buildDisplayModel with one installed. Spans whose buffer range lies inside a
// fold remap to start==end (and a non-monotone filter could yield start>end);
// applyTheme must drop them rather than paint garbage.
test("buildDisplayModel applies mode displayFilter: folds body, remaps point and spans", async () => {
  installDefaultModes()
  const editor = new Editor()
  installDefaultConfig(editor)
  installOrg(editor)
  const text = "* H\n** child\nbody\n* H2"
  const buffer = editor.scratch("fold-test", text, "org-mode")
  buffer.point = 0
  await editor.run("org-cycle") // fold lines 1..2 under * H
  // Overlay span entirely inside the folded region.
  editor.addOverlaySource(b =>
    b === buffer ? [{ start: text.indexOf("body"), end: text.indexOf("body") + 4, face: "error" }] : []
  )
  buffer.point = text.indexOf("child") // point also inside the fold

  const model = buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 30, cols: 80 } })
  const leaf = model.windows.kind === "leaf" ? model.windows.pane : null
  expect(leaf).not.toBeNull()
  const body = themedTextPlain(leaf!.body)

  // (1) folded subtree collapses to an ellipsis; * H2 immediately follows.
  expect(body.split("\n")).toEqual(["* H█..", "* H2"])
  expect(body).not.toContain("child")
  expect(body).not.toContain("body")
  // (2) the `error` span on "body" remapped to zero-width and was dropped — no
  //     underlined chunk leaked through (default theme: error = underline only).
  expect(leaf!.body.chunks.some(c => c.underline)).toBe(false)
  // (3) point inside the fold clamps to the end of `* H`; cursor sits on the ellipsis.
  expect(body.indexOf("█")).toBe("* H".length)
})

test("buildDisplayModel centers markdown body at markdown-fill-column", () => {
  installDefaultModes()
  const editor = new Editor()
  installDefaultConfig(editor)
  installMarkdown(editor)
  const line = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu"
  const buffer = editor.scratch("md-fill", line, "markdown")
  buffer.locals.set("markdown-visual-fill-column-mode", true)
  buffer.locals.set("markdown-fill-column", 40)
  buffer.locals.set("markdown-visual-fill-column-center-text", true)
  buffer.point = 0

  const model = buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 24, cols: 80 } })
  const leaf = model.windows.kind === "leaf" ? model.windows.pane : null
  expect(leaf).not.toBeNull()
  const rows = themedTextPlain(leaf!.body).split("\n")
  expect(rows.length).toBeGreaterThan(1)
  const margin = " ".repeat(20)
  for (const row of rows) expect(row.startsWith(margin)).toBe(true)
  expect(rows[0]!.slice(20).length).toBeLessThanOrEqual(40)
})
