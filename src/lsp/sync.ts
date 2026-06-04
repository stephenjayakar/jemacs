import type { BufferModel } from "../kernel/buffer"
import { bufferLanguageId, bufferUri, pointToPosition } from "./positions"
import { ensureBufferLspState } from "./buffer-state"
import type { LspWorkspace } from "./workspace"
import {
  lspMakeDidChangeTextDocumentParams,
  lspMakeDidCloseTextDocumentParams,
  lspMakeDidOpenTextDocumentParams,
  lspMakeTextDocumentItem,
  lspMakeVersionedTextDocumentIdentifier,
} from "./lsp-protocol"

export function textDocumentDidOpen(workspace: LspWorkspace, buffer: BufferModel): void {
  const uri = bufferUri(buffer)
  if (!uri) return
  const state = ensureBufferLspState(buffer, uri)
  if (!workspace.buffers.includes(buffer)) workspace.buffers.push(buffer)
  workspace.rpc.sendNotification(
    "textDocument/didOpen",
    lspMakeDidOpenTextDocumentParams({
      textDocument: lspMakeTextDocumentItem({
        uri,
        languageId: bufferLanguageId(buffer),
        version: state.version,
        text: buffer.text,
      }),
    }),
  )
}

export function textDocumentDidChange(
  workspace: LspWorkspace,
  buffer: BufferModel,
  change: { start: number; end: number; text: string },
  documentBefore: string,
): void {
  const uri = bufferUri(buffer)
  if (!uri) return
  const state = ensureBufferLspState(buffer, uri)
  state.version++
  workspace.rpc.sendNotification(
    "textDocument/didChange",
    lspMakeDidChangeTextDocumentParams({
      textDocument: lspMakeVersionedTextDocumentIdentifier({ uri, version: state.version }),
      contentChanges: [{
        range: {
          start: pointToPosition(documentBefore, change.start),
          end: pointToPosition(documentBefore, change.end),
        },
        text: change.text,
      }],
    }),
  )
}

/** Full-buffer sync (sync kind 1 in lsp-on-change). */
export function textDocumentDidChangeFull(workspace: LspWorkspace, buffer: BufferModel): void {
  const uri = bufferUri(buffer)
  if (!uri) return
  const state = ensureBufferLspState(buffer, uri)
  state.version++
  workspace.rpc.sendNotification(
    "textDocument/didChange",
    lspMakeDidChangeTextDocumentParams({
      textDocument: lspMakeVersionedTextDocumentIdentifier({ uri, version: state.version }),
      contentChanges: [{ text: buffer.text }],
    }),
  )
}

export function textDocumentDidClose(workspace: LspWorkspace, buffer: BufferModel): void {
  const uri = bufferUri(buffer)
  if (!uri) return
  workspace.rpc.sendNotification(
    "textDocument/didClose",
    lspMakeDidCloseTextDocumentParams({
      textDocument: { uri },
    }),
  )
  workspace.buffers = workspace.buffers.filter(b => b !== buffer)
}
