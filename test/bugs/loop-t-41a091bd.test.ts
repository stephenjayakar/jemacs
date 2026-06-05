import { expect, test } from "bun:test"
import { makeEditor } from "../plugins/helper"
import { buildDisplayModel } from "../../src/display/build-display-model"
import { themedTextPlain } from "../../src/display/themed-text"

// t-41a091bd: M-> puts point on the last body row; wrapBodyRows then adds
// continuation rows for any long line in view, so the host's fixed-height
// body truncates the cursor row. syncSelectedWindowViewport's math is fine —
// the row budget is consumed by wrapping it can't see.
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
