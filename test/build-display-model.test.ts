import { expect, test } from "bun:test"
import { buildDisplayModel } from "../src/display/build-display-model"
import { themedTextPlain } from "../src/display/themed-text"
import { Editor } from "../src/kernel/editor"
import { installDefaultConfig } from "../src/config"
import { installDefaultModes } from "../src/modes/default-modes"
import { defaultTheme } from "../src/themes"
import { install as installOrg } from "../plugins/org"

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
  expect(buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 24 } }).theme.name)
    .toBe(defaultTheme.name)
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
