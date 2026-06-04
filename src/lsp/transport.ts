/** Content-Length JSON-RPC transport (lsp--make-message, lsp--create-filter-function). */

import type { LSPAny } from "vscode-languageserver-types"

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
  const body = JSON.stringify(message)
  const bytes = new TextEncoder().encode(body).byteLength
  return `Content-Length: ${bytes}\r\n\r\n${body}`
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
  private bodyLength: number | null = null
  private bodyReceived = 0
  private bodyChunks: string[] = []
  private leftovers = ""

  feed(chunk: string): JsonRpcMessage[] {
    if (this.leftovers) chunk = this.leftovers + chunk
    this.leftovers = ""
    const messages: JsonRpcMessage[] = []

    while (chunk.length > 0) {
      if (this.bodyLength == null) {
        const sep = chunk.indexOf("\r\n\r\n")
        if (sep === -1) {
          this.leftovers = chunk
          break
        }
        const headerBlock = chunk.slice(0, sep)
        const match = headerBlock.match(/Content-Length:\s*(\d+)/i)
        if (!match) throw new Error("Unable to find Content-Length header")
        this.bodyLength = Number(match[1])
        this.bodyReceived = 0
        this.bodyChunks = []
        chunk = chunk.slice(sep + 4)
        continue
      }

      const left = this.bodyLength - this.bodyReceived
      const take = chunk.slice(0, left)
      const takeBytes = new TextEncoder().encode(take).byteLength
      this.bodyChunks.push(take)
      this.bodyReceived += takeBytes
      chunk = chunk.slice(take.length)

      if (this.bodyReceived >= this.bodyLength) {
        const body = this.bodyChunks.join("")
        this.bodyLength = null
        this.bodyReceived = 0
        this.bodyChunks = []
        try {
          messages.push(JSON.parse(body) as JsonRpcMessage)
        } catch (error) {
          throw new Error(`Failed to parse LSP JSON: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    return messages
  }
}
