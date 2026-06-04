import { LspMessageParser, makeRequest, messageKind, serializeMessage, type JsonRpcMessage } from "./transport"

export type PendingRequest = {
  method: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  sentAt: number
}

export type LspRpcConnection = {
  sendNotification: (method: string, params?: unknown) => void
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>
  requestAsync: (method: string, params: unknown | undefined, callback: (result: unknown) => void, onError?: (error: Error) => void) => number
  dispose: () => void
}

export function createRpcConnection(send: (payload: string) => void, onMessage: (msg: JsonRpcMessage) => void): {
  connection: LspRpcConnection
  feed: (chunk: string) => void
} {
  const parser = new LspMessageParser()
  let lastId = 0
  const pending = new Map<number, PendingRequest>()

  const feed = (chunk: string) => {
    for (const msg of parser.feed(chunk)) {
      const kind = messageKind(msg)
      if (kind === "response" || kind === "response-error") {
        const id = typeof msg.id === "string" ? Number(msg.id) : Number(msg.id)
        const entry = pending.get(id)
        if (entry) {
          pending.delete(id)
          if (msg.error) entry.reject(new Error(msg.error.message ?? "LSP request failed"))
          else entry.resolve(msg.result)
        }
      } else {
        onMessage(msg)
      }
    }
  }

  const connection: LspRpcConnection = {
    sendNotification(method, params) {
      send(serializeMessage({ jsonrpc: "2.0", method, params }))
    },
    requestAsync(method, params, callback, onError) {
      const id = ++lastId
      pending.set(id, {
        method,
        resolve: callback,
        reject: err => onError?.(err),
        sentAt: Date.now(),
      })
      send(serializeMessage(makeRequest(method, params, id)))
      return id
    },
    request(method, params, timeoutMs = 30_000) {
      return new Promise((resolve, reject) => {
        const id = connection.requestAsync(method, params, resolve, reject)
        const timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id)
            reject(new Error(`Timeout waiting for ${method}`))
          }
        }, timeoutMs)
        const original = pending.get(id)!
        pending.set(id, {
          ...original,
          resolve: value => {
            clearTimeout(timer)
            resolve(value)
          },
          reject: err => {
            clearTimeout(timer)
            reject(err)
          },
        })
      })
    },
    dispose() {
      pending.clear()
    },
  }

  return { connection, feed }
}
