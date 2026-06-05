import { expect, test } from "bun:test"
import { Editor } from "../../src/kernel/editor"
import { BufferModel } from "../../src/kernel/buffer"
import { applyWorkspaceEdit } from "../../plugins/lsp-extras"
import { pathToUri } from "../../src/lsp/positions"

// [erro-1] applyWorkspaceEdit had no per-file catch and no finally: an
// openFile throw mid-loop left earlier files mutated, later files untouched,
// and currentBuffer stranded on the last-opened file instead of origin.
test("t-53dc13cb: applyWorkspaceEdit survives mid-loop openFile throw and restores origin buffer", async () => {
  const editor = new Editor()
  const originId = editor.currentBufferId

  const opened: Record<string, BufferModel> = {}
  editor.openFile = async path => {
    if (path === "/p/b.ts") {
      throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: "EACCES" })
    }
    const buf = new BufferModel({ name: path, path, text: "foo\n", mode: "typescript" })
    editor.addBuffer(buf)
    editor.switchToBuffer(buf.id) // real openFile switches current buffer
    opened[path] = buf
    return buf
  }

  let msg = ""
  editor.events.on("message", e => { msg = e.text })

  const edit = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "bar" }
  const result = await applyWorkspaceEdit(editor, {
    changes: {
      [pathToUri("/p/a.ts")]: [edit],
      [pathToUri("/p/b.ts")]: [edit],
      [pathToUri("/p/c.ts")]: [edit],
    },
  })

  expect(editor.currentBufferId).toBe(originId)
  expect(opened["/p/a.ts"]!.text).toBe("bar\n")
  expect(opened["/p/c.ts"]!.text).toBe("bar\n")
  expect(result.files).toBe(2)
  expect(result.failed).toHaveLength(1)
  expect(result.failed[0]!.path).toBe("/p/b.ts")
  expect(msg).toContain("2 of 3 files")
  expect(msg).toContain("1 failed")
  expect(msg).toContain("/p/b.ts")
})
