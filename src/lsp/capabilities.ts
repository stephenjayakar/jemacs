/** Port of `lsp--client-capabilities` from lsp-mode.el (LSP 3.17). */

import {
  CodeActionKind,
  CompletionItemKind,
  SymbolKind,
  type ClientCapabilities,
} from "./lsp-protocol"

const symbolKindValueSet = Object.values(SymbolKind).filter(v => typeof v === "number") as number[]
const completionKindValueSet = Object.values(CompletionItemKind).filter(v => typeof v === "number") as number[]

export function clientCapabilities(custom?: ClientCapabilities): ClientCapabilities {
  const base: ClientCapabilities = {
    general: { positionEncodings: ["utf-16", "utf-32"] },
    workspace: {
      applyEdit: true,
      workspaceEdit: {
        documentChanges: true,
        resourceOperations: ["create", "rename", "delete"],
      },
      symbol: { symbolKind: { valueSet: symbolKindValueSet } },
      executeCommand: { dynamicRegistration: false },
      didChangeWatchedFiles: { dynamicRegistration: true },
      workspaceFolders: true,
      configuration: true,
      fileOperations: {
        didCreate: false,
        willCreate: false,
        didRename: true,
        willRename: true,
        didDelete: false,
        willDelete: false,
      },
    },
    textDocument: {
      declaration: { dynamicRegistration: true, linkSupport: true },
      definition: { dynamicRegistration: true, linkSupport: true },
      references: { dynamicRegistration: true },
      implementation: { dynamicRegistration: true, linkSupport: true },
      typeDefinition: { dynamicRegistration: true, linkSupport: true },
      synchronization: { willSave: true, didSave: true, willSaveWaitUntil: false },
      documentSymbol: {
        symbolKind: { valueSet: symbolKindValueSet },
        hierarchicalDocumentSymbolSupport: true,
      },
      formatting: { dynamicRegistration: true },
      rangeFormatting: { dynamicRegistration: true },
      onTypeFormatting: { dynamicRegistration: true },
      rename: { dynamicRegistration: true, prepareSupport: true },
      codeAction: {
        dynamicRegistration: true,
        isPreferredSupport: true,
        codeActionLiteralSupport: {
          codeActionKind: {
            valueSet: [
              "",
              CodeActionKind.QuickFix,
              CodeActionKind.Refactor,
              CodeActionKind.RefactorExtract,
              CodeActionKind.RefactorInline,
              CodeActionKind.RefactorRewrite,
              CodeActionKind.Source,
              CodeActionKind.SourceOrganizeImports,
            ],
          },
        },
        resolveSupport: { properties: ["edit", "command"] },
        dataSupport: true,
      },
      completion: {
        completionItem: {
          snippetSupport: false,
          documentationFormat: ["markdown", "plaintext"],
          resolveAdditionalTextEditsSupport: true,
          insertReplaceSupport: true,
          deprecatedSupport: true,
          resolveSupport: {
            properties: ["documentation", "detail", "additionalTextEdits", "command"],
          },
          insertTextModeSupport: { valueSet: [1, 2] },
        },
        contextSupport: true,
        dynamicRegistration: true,
      },
      signatureHelp: {
        signatureInformation: { parameterInformation: { labelOffsetSupport: true } },
        dynamicRegistration: true,
      },
      documentLink: { dynamicRegistration: true, tooltipSupport: true },
      hover: { contentFormat: ["markdown", "plaintext"], dynamicRegistration: true },
      foldingRange: { dynamicRegistration: true },
      selectionRange: { dynamicRegistration: true },
      callHierarchy: { dynamicRegistration: false },
      typeHierarchy: { dynamicRegistration: true },
      publishDiagnostics: {
        relatedInformation: true,
        tagSupport: { valueSet: [1, 2] },
        versionSupport: true,
      },
      linkedEditingRange: { dynamicRegistration: true },
    },
    window: { workDoneProgress: true, showDocument: { support: true } },
  }
  return custom ? { ...base, ...custom, workspace: { ...base.workspace, ...custom.workspace }, textDocument: { ...base.textDocument, ...custom.textDocument } } : base
}
