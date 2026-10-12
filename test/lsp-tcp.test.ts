import { expect, test } from "bun:test"
import { createServer } from "node:net"
import { tcpConnection } from "../src/lsp/tcp"

/** Poll COND until it holds or 5s pass; the assertions after it report a miss. */
async function until(cond: () => boolean): Promise<void> {
  for (const deadline = Date.now() + 5000; !cond() && Date.now() < deadline;) {
    await new Promise(r => setTimeout(r, 10))
  }
}

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

  // Wait for the TCP roundtrip; a fixed 50ms sleep flaked on a loaded machine.
  await until(() => receivedData === "hello lsp")

  expect(receivedData).toBe("hello lsp")
  expect(closed).toBe(false)

  // Kill the connection
  handle.proc.kill()

  await until(() => closed)
  expect(closed).toBe(true)

  // Close server
  await new Promise<void>(resolve => {
    server.close(() => resolve())
  })
})
