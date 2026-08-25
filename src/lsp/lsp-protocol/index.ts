/**
 * Full LSP 3.17 protocol bindings for Jemacs.
 *
 * - Official types: vscode-languageserver-types / vscode-languageserver-protocol
 * - Emacs parity: lsp-make-* builders, lsp-*? predicates, enum constants (from lsp-protocol.el)
 */

export * from "vscode-languageserver-types"
export type {
  ClientCapabilities,
  InitializeParams,
  InitializeResult,
  ServerCapabilities,
  _InitializeParams,
} from "vscode-languageserver-protocol"
export {
  InitializeRequest,
  InitializedNotification,
  ShutdownRequest,
  ExitNotification,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidSaveTextDocumentNotification,
  PublishDiagnosticsNotification,
  CompletionRequest,
  CompletionTriggerKind,
  DefinitionRequest,
  ReferencesRequest,
  HoverRequest,
  CodeActionRequest,
  RenameRequest,
  DocumentFormattingRequest,
  DocumentRangeFormattingRequest,
  SignatureHelpRequest,
} from "vscode-languageserver-protocol"

export * from "./generated/builders"
export * from "./generated/enums"
export * from "./generated/registry"
export * from "./jsonrpc"
export * from "./errors"
