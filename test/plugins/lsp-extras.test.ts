import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { makeEditor } from "./helper"
import { applyWorkspaceEdit, hoverInfo, install } from "../../plugins/lsp-extras"
import { BufferModel } from "../../src/kernel/buffer"
import { LspManager } from "../../src/lsp/manager"
import { bufferUri, pathToUri } from "../../src/lsp/positions"
import type { LspWorkspace } from "../../src/lsp/workspace"

type Handler = (method: string, params: unknown) => unknown

function fakeWorkspace(handler: Handler): { ws: LspWorkspace; calls: Array<{ method: string; params: unknown }> } {
  const calls: Array<{ method: string; params: unknown }> = []
  const ws: LspWorkspace = {
    root: "/proj",
    client: {
      serverId: "fake",
      majorModes: ["typescript"],
      priority: 0,
      languageId: () => "typescript",
      newConnection: { connect: () => ({ send: () => {}, proc: { kill: () => {} } }) },
    },
    status: "initialized",
    buffers: [],
    openedUris: new Set(),
    serverCapabilities: { hoverProvider: true, renameProvider: true, referencesProvider: true },
    diagnosticsByPath: new Map(),
    rpc: {
      sendNotification: () => {},
      request: async (method, params) => {
        calls.push({ method, params })
        return handler(method, params)
      },
      requestAsync: () => 0,
      dispose: () => {},
    },
    send: () => {},
    kill: () => {},
    uriForBuffer: b => bufferUri(b) ?? "",
  }
  return { ws, calls }
}

function setup(handler: Handler) {
  const editor = makeEditor()
  install(editor)
  const manager = new LspManager(editor)
  editor.lsp = manager
  const path = resolve("/proj/a.ts")
  const buffer = new BufferModel({ name: "a.ts", path, text: "const foo = 1\nconsole.log(foo)\n", mode: "typescript" })
  editor.addBuffer(buffer)
  editor.switchToBuffer(buffer.id)
  const { ws, calls } = fakeWorkspace(handler)
  manager.enableLspMode(buffer, [ws])
  return { editor, buffer, ws, calls }
}

test("install registers commands and C-c r binding", () => {
  const editor = makeEditor()
  install(editor)
  expect(editor.commands.get("lsp-hover")).toBeDefined()
  expect(editor.commands.get("lsp-rename")).toBeDefined()
  expect(editor.commands.get("xref-find-references")).toBeDefined()
  expect(editor.commands.get("lsp-find-references")).toBeDefined()
  expect(editor.describeKey("C-c r")).toContain("lsp-rename")
  expect(editor.describeKey("M-?")).toContain("xref-find-references")
})

test("hoverInfo formats MarkupContent, MarkedString, and arrays", () => {
  expect(hoverInfo({ kind: "markdown", value: "**foo**" })).toBe("**foo**")
  expect(hoverInfo("plain")).toBe("plain")
  expect(hoverInfo({ language: "ts", value: "const x: number" })).toBe("```ts\nconst x: number\n```")
  expect(hoverInfo(["a", { kind: "plaintext", value: "b" }])).toBe("a\nb")
})

test("lsp-hover shows server contents in *lsp-help*", async () => {
  const { editor, buffer, calls } = setup(method => {
    if (method === "textDocument/hover") return { contents: { kind: "markdown", value: "const foo: 1" } }
    return null
  })
  buffer.point = buffer.text.indexOf("foo")
  await editor.run("lsp-hover")
  const hoverCall = calls.find(c => c.method === "textDocument/hover")
  expect(hoverCall).toBeDefined()
  expect((hoverCall!.params as { position: { line: number; character: number } }).position).toEqual({ line: 0, character: 6 })
  const help = [...editor.buffers.values()].find(b => b.name === "*lsp-help*")
  expect(help?.text).toBe("const foo: 1")
})

test("lsp-hover messages when server returns nothing", async () => {
  const { editor } = setup(() => null)
  let msg = ""
  editor.events.on("message", e => { msg = e.text })
  await editor.run("lsp-hover")
  expect(msg).toBe("No hover info at point")
  expect([...editor.buffers.values()].find(b => b.name === "*lsp-help*")).toBeUndefined()
})

test("lsp-rename applies WorkspaceEdit.changes across buffers", async () => {
  const pathA = resolve("/proj/a.ts")
  const pathB = resolve("/proj/b.ts")
  const uriA = pathToUri(pathA)
  const uriB = pathToUri(pathB)
  const { editor, buffer, calls } = setup(method => {
    if (method !== "textDocument/rename") return null
    return {
      changes: {
        [uriA]: [
          { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } }, newText: "bar" },
          { range: { start: { line: 1, character: 12 }, end: { line: 1, character: 15 } }, newText: "bar" },
        ],
        [uriB]: [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: "bar" },
        ],
      },
    }
  })
  const other = new BufferModel({ name: "b.ts", path: pathB, text: "foo()\n", mode: "typescript" })
  editor.addBuffer(other)
  buffer.point = buffer.text.indexOf("foo")

  await editor.run("lsp-rename", ["bar"])

  const renameCall = calls.find(c => c.method === "textDocument/rename")
  expect((renameCall!.params as { newName: string }).newName).toBe("bar")
  expect(buffer.text).toBe("const bar = 1\nconsole.log(bar)\n")
  expect(other.text).toBe("bar()\n")
  expect(editor.currentBufferId).toBe(buffer.id)
})

test("applyWorkspaceEdit prefers documentChanges over changes", async () => {
  const editor = makeEditor()
  const path = resolve("/proj/c.ts")
  const buf = new BufferModel({ name: "c.ts", path, text: "x y\n", mode: "typescript" })
  editor.addBuffer(buf)
  const uri = pathToUri(path)
  const count = await applyWorkspaceEdit(editor, {
    changes: { [uri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "WRONG" }] },
    documentChanges: [
      {
        textDocument: { uri, version: 1 },
        edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "z" }],
      },
    ],
  })
  expect(count.edits).toBe(1)
  expect(buf.text).toBe("z y\n")
})

test("lsp-find-references with single result jumps directly", async () => {
  const pathA = resolve("/proj/a.ts")
  const { editor, buffer } = setup(method => {
    if (method !== "textDocument/references") return null
    return [{ uri: pathToUri(pathA), range: { start: { line: 1, character: 12 }, end: { line: 1, character: 15 } } }]
  })
  buffer.point = buffer.text.indexOf("foo")
  await editor.run("xref-find-references")
  expect(editor.currentBuffer.path).toBe(pathA)
  expect(buffer.point).toBe(buffer.text.indexOf("foo", 10))
})

test("lsp-find-references with multiple results lists them in *xref*", async () => {
  const pathA = resolve("/proj/a.ts")
  const uriA = pathToUri(pathA)
  const { editor, buffer, calls } = setup(method => {
    if (method !== "textDocument/references") return null
    return [
      { uri: uriA, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } } },
      { uri: uriA, range: { start: { line: 1, character: 12 }, end: { line: 1, character: 15 } } },
    ]
  })
  buffer.point = 6
  const pending = editor.run("lsp-find-references")
  await new Promise(r => setTimeout(r, 0))
  const refCall = calls.find(c => c.method === "textDocument/references")
  expect((refCall!.params as { context: { includeDeclaration: boolean } }).context.includeDeclaration).toBe(true)
  const xref = [...editor.buffers.values()].find(b => b.name === "*xref*")
  expect(xref).toBeDefined()
  const lines = xref!.text.split("\n")
  expect(lines).toHaveLength(2)
  expect(lines[0]).toContain(":1:7")
  expect(lines[0]).toContain("const foo = 1")
  expect(lines[1]).toContain(":2:13")
  editor.minibufferCancel()
  await pending
})

test("lsp-find-references messages when no results", async () => {
  const { editor } = setup(method => (method === "textDocument/references" ? [] : null))
  let msg = ""
  editor.events.on("message", e => { msg = e.text })
  await editor.run("lsp-find-references")
  expect(msg).toBe("No references found")
})

test("commands message when LSP is inactive", async () => {
  const editor = makeEditor()
  install(editor)
  let msg = ""
  editor.events.on("message", e => { msg = e.text })
  await editor.run("lsp-hover")
  expect(msg).toBe("LSP is not active for this buffer")
})
