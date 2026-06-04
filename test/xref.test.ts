import { expect, test } from "bun:test"
import { BufferModel } from "../src/kernel/buffer"
import { parseDefinitionResult } from "../src/lsp/definition"
import { bufferSearchDefinitions } from "../src/xref/jump"
import { xrefGoBack, xrefPushMark } from "../src/xref/history"
import { Editor } from "../src/kernel/editor"
import { installXref } from "../src/xref/install"

test("parseDefinitionResult handles Location and LocationLink", () => {
  const single = parseDefinitionResult({
    uri: "file:///tmp/foo.py",
    range: { start: { line: 4, character: 0 }, end: { line: 4, character: 3 } },
  })
  expect(single).toHaveLength(1)
  expect(single[0]).toMatchObject({ kind: "file", path: "/tmp/foo.py", line: 4, column: 0 })

  const linked = parseDefinitionResult([{
    targetUri: "file:///tmp/bar.ts",
    targetRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
    targetSelectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
  }])
  expect(linked[0]).toMatchObject({ kind: "file", path: "/tmp/bar.ts", line: 1, column: 2 })
})

test("bufferSearchDefinitions finds python defs in current buffer", () => {
  const buffer = new BufferModel({
    name: "x.py",
    text: "import os\n\ndef helper():\n    pass\n\nclass Widget:\n    pass\n",
    mode: "python",
  })
  buffer.point = buffer.text.indexOf("helper")
  expect(bufferSearchDefinitions(buffer, "helper")).toHaveLength(1)
  expect(bufferSearchDefinitions(buffer, "Widget")).toHaveLength(1)
  expect(bufferSearchDefinitions(buffer, "missing")).toHaveLength(0)
})

test("xref history push and go-back restore position", () => {
  const editor = new Editor()
  installXref(editor)
  const buffer = editor.currentBuffer
  buffer.setText("alpha\nbeta\ngamma", false)
  buffer.point = buffer.text.indexOf("beta")
  const start = buffer.point
  xrefPushMark(editor, buffer)
  buffer.point = buffer.text.length
  expect(xrefGoBack(editor)).toBe(true)
  expect(buffer.point).toBe(start)
})

test("xref-find-definitions is bound to M-.", () => {
  const editor = new Editor()
  installXref(editor)
  expect(editor.keymap.get("M-.")).toBe("xref-find-definitions")
  expect(editor.commands.get("xref-find-definitions")).toBeDefined()
  expect(editor.commands.get("lsp-find-definition")).toBeUndefined()
})
