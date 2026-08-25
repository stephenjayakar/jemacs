import { expect, test } from "bun:test"
import { createServer } from "node:net"
import { tcpConnection } from "../src/lsp/tcp"

test("tcpConnection establishes TCP connection and forwards data", async () => {
  // Create a dummy TCP server that echos back
  const server = createServer(socket => {
    socket.on("data", chunk => {
      socket.write(chunk)
    })
  })

  // Start server on a random port
  await new Promise<void>(resolve => {
    server.listen(0, "127.0.0.1", resolve)
  })

  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("Failed to get server address")
  }
  const port = address.port

  // Test the connection
  const conn = tcpConnection(port, "127.0.0.1")
  expect(conn.test?.()).toBe(true)

  let receivedData = ""
  let closed = false

  const handle = conn.connect({
    onData(chunk) {
      receivedData += chunk
    },
    onExit() {
      closed = true
    },
    serverId: "test-tcp-lsp",
    cwd: process.cwd(),
  })

  // Send a message
  handle.send("hello lsp")

  // Wait a bit for the TCP roundtrip
  await new Promise(r => setTimeout(r, 50))

  expect(receivedData).toBe("hello lsp")
  expect(closed).toBe(false)

  // Kill the connection
  handle.proc.kill()

  // Wait a bit for close event
  await new Promise(r => setTimeout(r, 50))
  expect(closed).toBe(true)

  // Close server
  await new Promise<void>(resolve => {
    server.close(() => resolve())
  })
})
