import type { BufferModel } from "../kernel/buffer"
import { clientCapabilities } from "./capabilities"
import type { LspClient } from "./client"
import { handlePublishDiagnostics } from "./diagnostics"
import { bufferUri, pathToUri } from "./positions"
import { createRpcConnection, type LspRpcConnection } from "./rpc"
import { textDocumentDidOpen } from "./sync"
import { makeResponse, serializeMessage, type JsonRpcMessage } from "./transport"
import {
  lspMakeInitializeParams,
  lspInitializeResultP,
  type InitializeParams,
  type InitializeResult,
  type ServerCapabilities,
} from "./lsp-protocol"
import type { LspDiagnostic } from "./buffer-state"

export type WorkspaceStatus = "starting" | "initialized" | "shutdown"

export type LspWorkspace = {
  root: string
  client: LspClient
  status: WorkspaceStatus
  buffers: BufferModel[]
  serverCapabilities: ServerCapabilities | null
  diagnosticsByPath: Map<string, LspDiagnostic[]>
  rpc: LspRpcConnection
  send: (payload: string) => void
  kill: () => void
  onDiagnosticsUpdated?: (path: string) => void
  uriForBuffer: (buffer: BufferModel) => string
}

export async function startWorkspace(
  client: LspClient,
  root: string,
  buffers: BufferModel[],
): Promise<LspWorkspace> {
  let feed: (chunk: string) => void = () => {}
  let killProc = () => {}
  let sendFn: (payload: string) => void = () => {}

  const defaultHandlers = new Map<string, (workspace: LspWorkspace, params: unknown) => void>([
    ["textDocument/publishDiagnostics", handlePublishDiagnostics],
    ["window/logMessage", (_w, params) => {
      const p = params as { message?: string }
      if (p.message) console.error(`[${client.serverId}] ${p.message}`)
    }],
    ["window/showMessage", () => {}],
  ])

  const workspace: LspWorkspace = {
    root,
    client,
    status: "starting",
    buffers: [...buffers],
    serverCapabilities: null,
    diagnosticsByPath: new Map(),
    rpc: null as unknown as LspRpcConnection,
    send: payload => sendFn(payload),
    kill: () => killProc(),
    uriForBuffer(buffer) {
      return bufferUri(buffer) ?? pathToUri(buffer.path!)
    },
  }

  const onMessage = (msg: JsonRpcMessage) => {
    if (msg.method && msg.id != null && msg.result === undefined && msg.error === undefined) {
      void handleServerRequest(workspace, msg)
      return
    }
    if (msg.method) {
      const handler = client.notificationHandlers?.get(msg.method)
        ?? defaultHandlers.get(msg.method)
      handler?.(workspace, msg.params)
    }
  }

  const { connection, feed: feedFn } = createRpcConnection(payload => sendFn(payload), onMessage)
  workspace.rpc = connection
  feed = feedFn

  const conn = client.newConnection.connect({
    cwd: root,
    serverId: client.serverId,
    onData: chunk => feed(chunk),
    onExit: () => {
      workspace.status = "shutdown"
    },
  })
  sendFn = conn.send
  killProc = () => conn.proc.kill()

  const initOptions = typeof client.initializationOptions === "function"
    ? client.initializationOptions()
    : client.initializationOptions

  const initParams = lspMakeInitializeParams({
    processId: process.pid,
    rootUri: pathToUri(root),
    rootPath: root,
    capabilities: clientCapabilities(),
    clientInfo: { name: "jemacs", version: "0.1.0" },
    initializationOptions: initOptions ?? {},
  }) as InitializeParams

  const result = await workspace.rpc.request("initialize", initParams)
  if (!lspInitializeResultP(result)) throw new Error("Invalid initialize response from language server")
  workspace.serverCapabilities = (result as InitializeResult).capabilities ?? null
  workspace.status = "initialized"
  workspace.rpc.sendNotification("initialized", {})
  client.initializedFn?.(workspace)

  for (const buffer of workspace.buffers) {
    if (buffer.path) textDocumentDidOpen(workspace, buffer)
  }

  return workspace
}

async function handleServerRequest(workspace: LspWorkspace, msg: JsonRpcMessage): Promise<void> {
  const id = msg.id!
  const method = msg.method!
  if (method === "workspace/configuration") {
    workspace.send(serializeMessage(makeResponse(id, [{}])))
    return
  }
  if (method === "workspace/workspaceFolders") {
    workspace.send(serializeMessage(makeResponse(id, [{
      uri: pathToUri(workspace.root),
      name: workspace.root.split("/").pop() ?? workspace.root,
    }])))
    return
  }
  workspace.send(serializeMessage(makeResponse(id, null)))
}

export async function shutdownWorkspace(workspace: LspWorkspace): Promise<void> {
  if (workspace.status === "shutdown") return
  try {
    await workspace.rpc.request("shutdown", null, 2000)
  } catch {
    // server may already be gone
  }
  workspace.rpc.sendNotification("exit", {})
  workspace.kill()
  workspace.status = "shutdown"
}
