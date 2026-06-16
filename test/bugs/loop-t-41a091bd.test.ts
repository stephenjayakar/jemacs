import { expect, test } from "bun:test"
import { makeEditor } from "../plugins/helper"
import { buildDisplayModel } from "../../src/display/build-display-model"
import { themedTextPlain } from "../../src/display/themed-text"
import { findWindowLeaf } from "../../src/kernel/window"

// t-41a091bd: M-> puts point on the last body row; wrapBodyRows then adds
// continuation rows for any long line in view, so the host's fixed-height
// body can truncate the cursor row if viewport math and wrapping disagree.
test("end-of-buffer: cursor stays within bodyLineBudget when a visible line wraps", async () => {
  const editor = makeEditor()
  const lines = Array.from({ length: 48 }, (_, i) => `line ${i}`)
  lines.push("X".repeat(200), "last")
  editor.scratch("t.txt", lines.join("\n") + "\n", "text").point = 0

  await editor.run("end-of-buffer")

  const model = buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 30, cols: 80 } })
  const pane = model.windows.kind === "leaf" ? model.windows.pane : null
  const rows = themedTextPlain(pane!.body).split("\n")
  const cursorRow = rows.findIndex(r => r.includes("█"))
  expect(cursorRow).toBeGreaterThanOrEqual(0)
  expect(cursorRow).toBeLessThan(pane!.bodyLineBudget)
  expect(rows.length).toBeLessThanOrEqual(pane!.bodyLineBudget)
})

// The non-wrapping path is already correct — pin it so a fix that drops rows
// from the wrong end doesn't regress the simple case.
test("end-of-buffer: cursor on last body row when nothing wraps (trailing newline)", async () => {
  const editor = makeEditor()
  const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n") + "\n"
  editor.scratch("t.txt", text, "text").point = 0

  await editor.run("end-of-buffer")

  const model = buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 30, cols: 80 } })
  const pane = model.windows.kind === "leaf" ? model.windows.pane : null
  const rows = themedTextPlain(pane!.body).split("\n")
  expect(rows.length).toBe(pane!.bodyLineBudget)
  expect(rows.at(-1)).toBe("█")
})

test("end-of-buffer: cursor stays visible inside one long wrapped line", async () => {
  const editor = makeEditor()
  editor.scratch("t.txt", "X".repeat(400), "text").point = 0

  await editor.run("end-of-buffer")

  const model = buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 8, cols: 40 } })
  const pane = model.windows.kind === "leaf" ? model.windows.pane : null
  const rows = themedTextPlain(pane!.body).split("\n")
  const cursorRow = rows.findIndex(r => r.includes("█"))
  expect(cursorRow).toBeGreaterThanOrEqual(0)
  expect(cursorRow).toBeLessThan(pane!.bodyLineBudget)
  expect(rows.length).toBe(pane!.bodyLineBudget)
})

test("wrapped JSON value before point counts against the cursor boundary", () => {
  const editor = makeEditor()
  const text = `{\n  "payload": "${"x".repeat(320)}",\n  "ok": true\n}\n`
  const buffer = editor.scratch("data.json", text, "json")
  buffer.point = text.indexOf('  "ok"')

  const model = buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 8, cols: 40 } })
  const leaf = findWindowLeaf(editor.windowLayout, editor.selectedWindowId)!
  const pane = model.windows.kind === "leaf" ? model.windows.pane : null
  const firstRow = themedTextPlain(pane!.body).split("\n")[0]!
  expect(leaf.startLine).toBeGreaterThanOrEqual(2)
  expect(firstRow).toContain('"ok"')
})
