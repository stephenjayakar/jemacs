/** JSON-RPC shapes from lsp-protocol.el (JSONResponse, JSONNotification, JSONError). */

import type { LSPAny } from "vscode-languageserver-types"

export type JSONNotification = {
  jsonrpc: "2.0"
  method: string
  params?: LSPAny
}

export type JSONRequest = JSONNotification & {
  id: number | string
}

export type JSONResponse = {
  jsonrpc: "2.0"
  id: number | string
  result?: LSPAny
  error?: JSONError
}

export type JSONError = {
  code: number
  message: string
  data?: LSPAny
}

export function lspJsonResponseP(value: unknown): value is JSONResponse {
  return value != null && typeof value === "object" && "jsonrpc" in value && "id" in value
}

export function lspJsonErrorMessage(error: JSONError): string {
  return `Error from the Language Server: ${error.message} (${error.code})`
}

export function lspJsonMessageMethod(value: { method?: string }): string | undefined {
  return value.method
}

export function lspJsonResponseResult(value: JSONResponse): LSPAny | undefined {
  return value.result
}

export function lspJsonResponseId(value: JSONResponse): number | string {
  return value.id
}
