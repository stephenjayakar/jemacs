import { expect, test } from "bun:test"
import { LspMessageParser, serializeMessage } from "../src/lsp/transport"
import {
  lspMakePosition,
  lspMakePublishDiagnosticsParams,
  lspPositionP,
  lspPublishDiagnosticsParamsP,
  CompletionItemKind,
} from "../src/lsp/lsp-protocol"
import { pointToPosition, positionToPoint } from "../src/lsp/positions"

test("LspMessageParser reads Content-Length framed messages", () => {
  const parser = new LspMessageParser()
  const body = serializeMessage({ jsonrpc: "2.0", method: "initialized", params: {} })
  const messages = parser.feed(body)
  expect(messages).toHaveLength(1)
  expect(messages[0]?.method).toBe("initialized")
})

test("lsp-protocol builders and predicates", () => {
  const pos = lspMakePosition({ line: 1, character: 2 })
  expect(lspPositionP(pos)).toBe(true)
  const diag = lspMakePublishDiagnosticsParams({ uri: "file:///x", diagnostics: [] })
  expect(lspPublishDiagnosticsParamsP(diag)).toBe(true)
  expect(CompletionItemKind.Function).toBe(3)
})

test("pointToPosition and positionToPoint round-trip", () => {
  const text = "def foo():\n  return 1\n"
  const point = text.indexOf("return")
  const pos = pointToPosition(text, point)
  expect(pos.line).toBe(1)
  expect(positionToPoint(text, pos)).toBe(point)
})
