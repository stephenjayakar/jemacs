import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { makeEditor } from "./helper"
import { install as installLspExtras } from "../../plugins/lsp-extras"
import { install as installNextError, locationIndex, locationList } from "../../plugins/next-error"
import { BufferModel } from "../../src/kernel/buffer"
import { LspManager } from "../../src/lsp/manager"
import { bufferUri, pathToUri } from "../../src/lsp/positions"
import type { LspWorkspace } from "../../src/lsp/workspace"
import { installXref } from "../../src/xref/install"

type Handler = (method: string, params: unknown) => unknown

function fakeWorkspace(handler: Handler): LspWorkspace {
  return {
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
    serverCapabilities: { referencesProvider: true },
    diagnosticsByPath: new Map(),
    rpc: {
      sendNotification: () => {},
      request: async (method, params) => handler(method, params),
      requestAsync: () => 0,
      dispose: () => {},
    },
    send: () => {},
    kill: () => {},
    uriForBuffer: b => bufferUri(b) ?? "",
  }
}

function setup() {
  const editor = makeEditor()
  installXref(editor)
  installNextError(editor)
  installLspExtras(editor)
  const manager = new LspManager(editor)
  editor.lsp = manager
  const path = resolve("/proj/a.ts")
  const uri = pathToUri(path)
  const buffer = new BufferModel({ name: "a.ts", path, text: "const foo = 1\nconsole.log(foo)\n", mode: "typescript" })
  editor.addBuffer(buffer)
  editor.switchToBuffer(buffer.id)
  manager.enableLspMode(buffer, [fakeWorkspace(method => {
    if (method !== "textDocument/references") return null
    return [
      { uri, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } } },
      { uri, range: { start: { line: 1, character: 12 }, end: { line: 1, character: 15 } } },
    ]
  })])
  return { editor, buffer, path }
}

test("xref-find-references renders grouped xref-mode results and RET/n/p work", async () => {
  const { editor, buffer, path } = setup()
  buffer.point = buffer.text.indexOf("foo")

  await editor.run("xref-find-references")

  const xref = editor.currentBuffer
  expect(xref.name).toBe("*xref*")
  expect(xref.mode).toBe("xref-mode")
  expect(xref.text).toContain(`${path}\n`)
  expect(xref.text).toContain("  1:7: const foo = 1")
  expect(xref.text).toContain("  2:13: console.log(foo)")
  expect(locationList(editor)).toEqual([
    { file: path, line: 1, col: 7, text: "const foo = 1" },
    { file: path, line: 2, col: 13, text: "console.log(foo)" },
  ])
  expect(xref.text.slice(xref.point).startsWith("  1:7:")).toBe(true)

  await editor.handleKey({ name: "n", sequence: "n" })
  expect(editor.currentBuffer).toBe(xref)
  expect(xref.text.slice(xref.point).startsWith("  2:13:")).toBe(true)

  await editor.handleKey({ name: "p", sequence: "p" })
  expect(editor.currentBuffer).toBe(xref)
  expect(xref.text.slice(xref.point).startsWith("  1:7:")).toBe(true)

  await editor.handleKey({ name: "return", sequence: "\r" })
  expect(editor.currentBuffer.path).toBe(path)
  expect(editor.currentBuffer.lineCol()).toEqual({ line: 1, col: 7 })
  expect(locationIndex(editor)).toBe(0)
})

test("M-g n and M-g p visit xref results through next-error", async () => {
  const { editor, buffer, path } = setup()
  buffer.point = buffer.text.indexOf("foo")

  await editor.run("xref-find-references")

  await editor.run("next-error")
  expect(editor.currentBuffer.path).toBe(path)
  expect(editor.currentBuffer.lineCol()).toEqual({ line: 1, col: 7 })
  expect(locationIndex(editor)).toBe(0)

  await editor.run("next-error")
  expect(editor.currentBuffer.path).toBe(path)
  expect(editor.currentBuffer.lineCol()).toEqual({ line: 2, col: 13 })
  expect(locationIndex(editor)).toBe(1)

  await editor.run("previous-error")
  expect(editor.currentBuffer.path).toBe(path)
  expect(editor.currentBuffer.lineCol()).toEqual({ line: 1, col: 7 })
  expect(locationIndex(editor)).toBe(0)
})
