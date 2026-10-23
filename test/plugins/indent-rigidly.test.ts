import { expect, test } from "bun:test"
import { makeEditor } from "./helper"

// Ground truth from GNU Emacs 30 (`emacs --batch`, indent-tabs-mode nil).
async function setup(text: string, mark: number, point: number) {
  const editor = makeEditor()
  const buffer = editor.currentBuffer
  buffer.setText(text)
  buffer.mark = mark
  buffer.markActive = true
  buffer.point = point
  return { editor, buffer }
}

const key = (name: string, extra: Record<string, unknown> = {}) => ({ name, sequence: name.length === 1 ? name : "", ...extra })

test("C-x TAB opens the transient map; <right>, TAB, <left> shift the region", async () => {
  const { editor, buffer } = await setup("  a\n    b\nc", 0, 11)
  await editor.handleKey(key("x", { ctrl: true }))
  await editor.handleKey(key("tab"))
  expect(editor.overridingMap?.name).toBe("indent-rigidly-map")
  await editor.handleKey(key("right"))
  await editor.handleKey(key("tab"))
  expect(buffer.text).toBe("    a\n      b\n  c")
  expect(buffer.markActive).toBe(true)
  await editor.handleKey(key("left"))
  expect(buffer.text).toBe("   a\n     b\n c")
  // One undo reverts the whole interactive session.
  buffer.undo()
  expect(buffer.text).toBe("  a\n    b\nc")
})

test("S-<right> / S-<left> move to tab stops", async () => {
  const { editor, buffer } = await setup("  a\n    b\nc", 0, 11)
  await editor.run("indent-rigidly")
  await editor.handleKey(key("right", { shift: true }))
  expect(buffer.text).toBe("          a\n            b\n        c")
  await editor.handleKey(key("left", { shift: true }))
  expect(buffer.text).toBe("  a\n    b\nc")
  await editor.handleKey(key("left", { shift: true }))
  expect(buffer.text).toBe("a\nb\nc")
})

test("any other key exits the map, deactivates the mark, and runs normally", async () => {
  const { editor, buffer } = await setup("a\nb", 0, 3)
  await editor.run("indent-rigidly")
  await editor.handleKey(key("f", { ctrl: true }))
  expect(editor.overridingMap).toBeNull()
  expect(buffer.markActive).toBe(false)
  await editor.handleKey(key("right"))
  expect(buffer.text).toBe("a\nb")
})

test("prefix arg indents directly; blank lines lose whitespace; a partial first line is skipped", async () => {
  const { editor, buffer } = await setup("ab\n  cd\n\n   \nef\ngh", 2, 15)
  editor.prefixArg.addDigit(2)
  await editor.run("indent-rigidly")
  expect(buffer.text).toBe("ab\n    cd\n\n\n  ef\ngh")
  expect(editor.overridingMap).toBeNull()
})

test("negative prefix arg removes indentation", async () => {
  const { editor, buffer } = await setup("  a\n    b\n c", 0, 12)
  editor.prefixArg.toggleNegative()
  editor.prefixArg.addDigit(2)
  await editor.run("indent-rigidly")
  expect(buffer.text).toBe("a\n  b\nc")
})
