import { afterEach, expect, test } from "bun:test"
import { Editor } from "../../src/kernel/editor"
import { installDefaultConfig } from "../../src/config"
import { installDefaultModes } from "../../src/modes/default-modes"
import { runJemacsCore } from "../../src/run-core"
import { createWebHost, type WebHost } from "../../src/web/host"
import type { SerializedDisplayModel, SerializedWindowNode } from "../../src/display/serialize"

let host: WebHost | undefined

afterEach(() => {
  host?.destroy()
  host = undefined
})

async function makeHost(): Promise<WebHost> {
  installDefaultModes()
  const editor = new Editor()
  installDefaultConfig(editor)
  editor.scratch("web-test", "hello", "text")
  const h = await createWebHost({ port: 0, authTimeoutMs: 200 })
  h.attachEditor(editor)
  await runJemacsCore(editor, h)
  return h
}

function bodyText(node: SerializedWindowNode): string {
  if (node.kind === "leaf") return node.pane.body.chunks.map(c => c.text).join("")
  return bodyText(node.first)
}

function wsClosed(ws: WebSocket): Promise<{ code: number }> {
  return new Promise(resolve => ws.addEventListener("close", e => resolve({ code: e.code })))
}

function nextModel(ws: WebSocket): Promise<SerializedDisplayModel> {
  return new Promise(resolve => {
    ws.addEventListener("message", e => resolve(JSON.parse(String(e.data))), { once: true })
  })
}

test("GET / serves page with injected token for an allowed Host", async () => {
  host = await makeHost()
  const res = await fetch(`http://127.0.0.1:${host.port}/`, {
    headers: { Host: `127.0.0.1:${host.port}` },
  })
  expect(res.status).toBe(200)
  const html = await res.text()
  expect(html).toContain("__JEMACS_TOKEN__")
  expect(html).toContain(host.token)
  // Token must not appear in any URL we hand out.
  expect(html).not.toMatch(/\?.*token/)
})

test("GET / rejects mismatched Host header", async () => {
  host = await makeHost()
  const res = await fetch(`http://127.0.0.1:${host.port}/`, {
    headers: { Host: "evil.com" },
  })
  expect(res.status).toBe(403)
})

test("WS closes when first message is not auth", async () => {
  host = await makeHost()
  const ws = new WebSocket(`ws://127.0.0.1:${host.port}/ws`)
  await new Promise(r => ws.addEventListener("open", r, { once: true }))
  ws.send(JSON.stringify({ type: "key", key: { name: "a", sequence: "a" } }))
  const { code } = await wsClosed(ws)
  expect(code).toBe(1008)
})

test("WS closes on wrong token", async () => {
  host = await makeHost()
  const ws = new WebSocket(`ws://127.0.0.1:${host.port}/ws`)
  await new Promise(r => ws.addEventListener("open", r, { once: true }))
  ws.send(JSON.stringify({ type: "auth", token: "0".repeat(64) }))
  const { code } = await wsClosed(ws)
  expect(code).toBe(1008)
})

test("WS closes if no auth message arrives", async () => {
  host = await makeHost()
  const ws = new WebSocket(`ws://127.0.0.1:${host.port}/ws`)
  await new Promise(r => ws.addEventListener("open", r, { once: true }))
  const { code } = await wsClosed(ws)
  expect(code).toBe(1008)
})

test("WS with correct token receives a model and reflects input", async () => {
  host = await makeHost()
  const ws = new WebSocket(`ws://127.0.0.1:${host.port}/ws`)
  await new Promise(r => ws.addEventListener("open", r, { once: true }))
  const first = nextModel(ws)
  ws.send(JSON.stringify({ type: "auth", token: host.token }))
  const model = await first
  expect(model.hostLabel).toBe("Jemacs Web")
  expect(bodyText(model.windows)).toContain("hello")
  const leaf = model.windows.kind === "leaf" ? model.windows : null
  expect(leaf?.pane.cursor).toBeDefined()

  const second = nextModel(ws)
  ws.send(JSON.stringify({ type: "key", key: { name: "a", sequence: "a" } }))
  const after = await second
  expect(bodyText(after.windows)).toContain("ahello")
  ws.close()
})
