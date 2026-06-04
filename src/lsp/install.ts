import type { Editor } from "../kernel/editor"
import { registerAllLspClients } from "./clients"
import { lspExecuteCodeAction } from "./code-actions"
import { LspManager } from "./manager"
import { lspFindDefinition, lspFindImplementation } from "./navigation"

let installed = false

export function installLspMode(editor: Editor): LspManager {
  if (!installed) {
    registerAllLspClients()
    installed = true
  }
  const manager = new LspManager(editor)
  editor.lsp = manager
  manager.install()

  editor.command("lsp", async ({ editor, buffer }) => {
    await editor.lsp!.lsp(buffer)
  }, "Start the configured language server for the current buffer.")

  editor.command("lsp-mode", async ({ editor, buffer }) => {
    const state = editor.lsp!.bufferWorkspaces(buffer)
    if (state.length) {
      editor.lsp!.lspMode(buffer, false)
      editor.message("LSP mode disabled for buffer")
    } else {
      await editor.lsp!.lsp(buffer)
    }
  }, "Toggle LSP mode (starts server when enabling).")

  editor.command("lsp-shutdown-workspace", async ({ editor }) => {
    await editor.lsp!.shutdownWorkspaceCmd()
  }, "Shut down the language server for the current workspace.")

  editor.command("lsp-workspace-restart", async ({ editor }) => {
    await editor.lsp!.restartWorkspace()
  }, "Restart the language server workspace.")

  editor.command("lsp-describe-session", ({ editor }) => {
    editor.scratch("*lsp-session*", `${editor.lsp!.describeSession()}\n`, "text")
  }, "Describe active LSP workspaces.")

  editor.command("lsp-toggle-trace-io", ({ editor }) => {
    editor.lsp!.config.logIo = !editor.lsp!.config.logIo
    editor.message(`LSP trace IO ${editor.lsp!.config.logIo ? "enabled" : "disabled"}`)
  }, "Toggle logging of LSP IO.")

  editor.command("lsp-find-definition", async ({ editor, buffer }) => {
    await lspFindDefinition(editor, buffer)
  }, "Go to the LSP definition of the symbol at point.")

  editor.command("lsp-ui-peek-find-implementation", async ({ editor, buffer }) => {
    await lspFindImplementation(editor, buffer)
  }, "Go to the LSP implementation of the symbol at point.")

  editor.command("lsp-execute-code-action", async ({ editor, buffer }) => {
    await lspExecuteCodeAction(editor, buffer)
  }, "Run an LSP code action at point.")

  return manager
}
