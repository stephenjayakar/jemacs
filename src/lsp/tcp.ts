import { createConnection } from "node:net"
import type { BufferModel } from "../kernel/buffer"
import type { LspConnection } from "./client"

/** Port of remote TCP socket connection for LSP. */
export function tcpConnection(
  port: number,
  host = "localhost",
  testConnection?: (buffer?: BufferModel) => boolean | Promise<boolean>,
): LspConnection {
  return {
    connect({ onData, onExit, serverId }) {
      const socket = createConnection({ port, host })
      const decoder = new TextDecoder()

      socket.on("data", chunk => {
        onData(decoder.decode(chunk, { stream: true }))
      })

      socket.on("close", () => {
        onExit(null)
      })

      socket.on("error", () => {
        // Log/handle error onExit
        onExit(null)
      })

      return {
        proc: {
          kill() {
            socket.destroy()
          },
        },
        send(message: string) {
          socket.write(message)
        },
      }
    },
    test: testConnection ?? (() => true),
  }
}
