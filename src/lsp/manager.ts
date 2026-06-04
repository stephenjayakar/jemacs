import type { Editor } from "../kernel/editor"
import type { BufferModel } from "../kernel/buffer"
import { allClients, serverBinaryPresent, supportsBuffer, type LspClient } from "./client"
import { createSession, linkFolderToWorkspace, type LspSession } from "./session"
import { shouldAutoStartLsp } from "../config/lsp-auto-modes"
import { findProjectRoot } from "./project-root"
import { ensureBufferLspState, getBufferLspState, setBufferWorkspaces } from "./buffer-state"
import { bufferUri } from "./positions"
import { textDocumentDidChange, textDocumentDidChangeFull, textDocumentDidClose } from "./sync"
import { lspCompletionAtPoint } from "./completion"
import { lspDefinitionsAtPoint } from "./definition"
import type { XrefLocation } from "../xref/types"
import { diagnosticSpans as buildDiagnosticSpans } from "./diagnostics"
import type { LspWorkspace } from "./workspace"
import { shutdownWorkspace, startWorkspace } from "./workspace"
import type { CompletionCandidate } from "../modes/mode"
import type { TextSpan } from "../modes/mode"

export type LspConfig = {
  logIo: boolean
  autoEnable: boolean
}

export class LspManager {
  readonly session: LspSession = createSession()
  readonly workspaces: LspWorkspace[] = []
  config: LspConfig = { logIo: false, autoEnable: true }

  constructor(private readonly editor: Editor) {}

  install(): void {
    for (const buffer of this.editor.buffers.values()) {
      this.attachBuffer(buffer)
    }
  }

  attachBuffer(buffer: BufferModel): void {
    buffer.onTextChange = change => {
      const documentBefore = buffer.text
      const state = getBufferLspState(buffer)
      if (!state?.workspaces.length) return
      for (const workspace of state.workspaces) {
        if (workspace.status !== "initialized") continue
        if (change.start === 0 && change.end === documentBefore.length) {
          textDocumentDidChangeFull(workspace, buffer)
        } else {
          textDocumentDidChange(workspace, buffer, change, documentBefore)
        }
      }
      void this.editor.changed("lsp-sync")
    }
  }

  matchingClients(buffer: BufferModel): LspClient[] {
    return allClients()
      .filter(client => supportsBuffer(client, buffer))
      .filter(client => serverBinaryPresent(client, buffer))
      .sort((a, b) => b.priority - a.priority)
  }

  bufferWorkspaces(buffer: BufferModel): LspWorkspace[] {
    return getBufferLspState(buffer)?.workspaces ?? []
  }

  async lsp(buffer = this.editor.currentBuffer): Promise<void> {
    if (!buffer.path) {
      this.editor.message("Buffer is not visiting a file")
      return
    }
    const clients = this.matchingClients(buffer)
    if (!clients.length) {
      const supported = allClients().filter(client => supportsBuffer(client, buffer))
      const missing = supported.filter(client => !serverBinaryPresent(client, buffer))
      if (missing.length) {
        this.editor.message(
          `No LSP binary for ${buffer.mode} (install ${missing.map(c => c.serverId).join(", ")}; for TypeScript: bun add -d typescript-language-server)`,
        )
      } else {
        this.editor.message(`No LSP server for mode ${buffer.mode}`)
      }
      return
    }
    const client = clients[0]!
    const root = await findProjectRoot(buffer.path)
    const existing = this.workspaces.find(w => w.client.serverId === client.serverId && w.root === root && w.status === "initialized")
    if (existing) {
      existing.onDiagnosticsUpdated = () => void this.editor.changed("lsp-diagnostics")
      this.enableLspMode(buffer, [existing])
      this.editor.message(`Connected to [${client.serverId}]`)
      return
    }
    const workspace = await startWorkspace(client, root, [buffer])
    workspace.onDiagnosticsUpdated = () => void this.editor.changed("lsp-diagnostics")
    this.workspaces.push(workspace)
    linkFolderToWorkspace(this.session, root, workspace)
    this.enableLspMode(buffer, [workspace])
    this.editor.message(`Connected to [${client.serverId}] in ${root}`)
  }

  enableLspMode(buffer: BufferModel, workspaces: LspWorkspace[]): void {
    const uri = bufferUri(buffer)
    if (!uri) return
    const state = ensureBufferLspState(buffer, uri)
    state.lspMode = true
    state.workspaces = workspaces
    setBufferWorkspaces(buffer, workspaces)
    for (const workspace of workspaces) {
      if (!workspace.buffers.includes(buffer)) workspace.buffers.push(buffer)
    }
  }

  lspMode(buffer: BufferModel, enable: boolean): void {
    const state = getBufferLspState(buffer)
    if (!state) return
    state.lspMode = enable
    if (!enable) {
      for (const workspace of state.workspaces) textDocumentDidClose(workspace, buffer)
      state.workspaces = []
    }
  }

  async shutdownWorkspaceCmd(): Promise<void> {
    const workspaces = this.bufferWorkspaces(this.editor.currentBuffer)
    if (!workspaces.length) {
      this.editor.message("No LSP workspace for this buffer")
      return
    }
    for (const workspace of workspaces) await shutdownWorkspace(workspace)
    this.lspMode(this.editor.currentBuffer, false)
    this.editor.message("LSP workspace shut down")
  }

  async restartWorkspace(): Promise<void> {
    await this.shutdownWorkspaceCmd()
    await this.lsp()
  }

  describeSession(): string {
    if (!this.workspaces.length) return "No active LSP workspaces."
    return this.workspaces.map(w => `${w.client.serverId} @ ${w.root} (${w.status}) buffers=${w.buffers.length}`).join("\n")
  }

  async completionAtPoint(buffer: BufferModel): Promise<CompletionCandidate[]> {
    const workspaces = this.bufferWorkspaces(buffer).filter(w => w.status === "initialized")
    return lspCompletionAtPoint(buffer, workspaces)
  }

  async definitionsAtPoint(buffer: BufferModel): Promise<XrefLocation[]> {
    const workspaces = this.bufferWorkspaces(buffer).filter(w => w.status === "initialized")
    return lspDefinitionsAtPoint(buffer, workspaces)
  }

  diagnosticSpans(buffer: BufferModel): TextSpan[] {
    return buildDiagnosticSpans(buffer, this.bufferWorkspaces(buffer))
  }

  async maybeAutoStart(buffer: BufferModel): Promise<void> {
    if (!this.config.autoEnable || !buffer.path) return
    if (!shouldAutoStartLsp(buffer)) return
    const state = getBufferLspState(buffer)
    if (state?.lspMode) return
    if (this.matchingClients(buffer).length) await this.lsp(buffer)
  }
}
