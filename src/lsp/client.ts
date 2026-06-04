import type { BufferModel } from "../kernel/buffer"
import type { LspWorkspace } from "./workspace"

export type LspConnection = {
  connect: (args: {
    onData: (chunk: string) => void
    onExit: (code: number | null) => void
    serverId: string
    cwd: string
  }) => { proc: { kill: () => void }; send: (message: string) => void }
  test?: () => boolean | Promise<boolean>
}

/** Mirrors `cl-defstruct lsp--client` in lsp-mode.el. */
export type LspClient = {
  serverId: string
  majorModes: string[]
  activationFn?: (fileName: string | undefined, mode: string) => boolean
  priority: number
  addOn?: boolean
  multiRoot?: boolean
  languageId: (buffer: BufferModel) => string
  newConnection: LspConnection
  initializationOptions?: unknown | (() => unknown)
  initializedFn?: (workspace: LspWorkspace) => void
  notificationHandlers?: Map<string, NotificationHandler>
  requestHandlers?: Map<string, RequestHandler>
}

export type NotificationHandler = (workspace: LspWorkspace, params: unknown) => void
export type RequestHandler = (workspace: LspWorkspace, params: unknown) => unknown

const clients = new Map<string, LspClient>()

export function registerClient(client: LspClient): void {
  clients.set(client.serverId, client)
}

export function getClient(serverId: string): LspClient | undefined {
  return clients.get(serverId)
}

export function allClients(): LspClient[] {
  return [...clients.values()]
}

export function activateOn(...languages: string[]): (fileName: string | undefined, mode: string) => boolean {
  return (_fileName, mode) => languages.includes(mode)
}

export function supportsBuffer(client: LspClient, buffer: BufferModel): boolean {
  if (client.activationFn?.(buffer.path, buffer.mode)) return true
  return client.majorModes.includes(buffer.mode)
}

export function serverBinaryPresent(client: LspClient): boolean {
  if (client.newConnection.test) return client.newConnection.test() !== false
  return true
}
