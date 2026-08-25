/** Content-Length JSON-RPC transport (lsp--make-message, lsp--create-filter-function). */

import type { LSPAny } from "vscode-languageserver-types"
import { ContentLengthMessageParser, serializeContentLength } from "../protocol/content-length"

export type JsonRpcMessage = {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: LSPAny
  result?: LSPAny
  error?: { code?: number; message?: string; data?: LSPAny }
}

export type MessageKind = "request" | "response" | "response-error" | "notification"

export function makeNotification(method: string, params?: LSPAny): JsonRpcMessage {
  return { jsonrpc: "2.0", method, params }
}

export function makeRequest(method: string, params: LSPAny, id: number): JsonRpcMessage {
  return { jsonrpc: "2.0", id, method, params }
}

export function makeResponse(id: number | string, result: LSPAny): JsonRpcMessage {
  return { jsonrpc: "2.0", id, result }
}

export function serializeMessage(message: JsonRpcMessage): string {
  return serializeContentLength(message)
}

export function messageKind(data: JsonRpcMessage): MessageKind {
  if (data.error != null) return "response-error"
  if (data.id != null && (data.result !== undefined || data.error !== undefined)) {
    return data.error ? "response-error" : "response"
  }
  if (data.method) return data.id == null ? "notification" : "request"
  return "notification"
}

/** Incremental parser matching lsp--create-filter-function. */
export class LspMessageParser {
  private readonly parser = new ContentLengthMessageParser<JsonRpcMessage>()

  feed(chunk: string): JsonRpcMessage[] {
    return this.parser.feed(chunk)
  }
}
