import { describe, expect, test } from "bun:test"
import { Editor } from "../../src/kernel/editor"
import { BufferModel } from "../../src/kernel/buffer"
import { MemCas } from "../../src/shadow/cas"
import { attachAuthority, attachShadow, shadowState } from "../../src/shadow/shadow"
import { connectWs, serveShadow, type WsLink } from "../../src/shadow/ws-link"

async function until(pred: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("until: timed out")
    await new Promise(r => setTimeout(r, 5))
  }
}

describe("WsLink — serveShadow auth gate", () => {
  test("connect with the issued token: A↔S converge over a real socket", async () => {
    const A = new Editor()
    const S = new Editor()
    const bufA = A.addBuffer(new BufferModel({ id: "buf-1", name: "t", text: "" }))
    const bufS = S.addBuffer(new BufferModel({ id: "buf-1", name: "t", text: "" }))

    let aLink: WsLink | undefined
    const srv = serveShadow(link => {
      aLink = link
      attachAuthority(A, link, { cas: new MemCas() })
    })
    expect(srv.port).toBeGreaterThan(0)
    expect(srv.token.length).toBeGreaterThanOrEqual(32)
    expect(srv.url).toBe(`ws://127.0.0.1:${srv.port}/?token=${srv.token}`)

    try {
      const sLink = connectWs(srv.url)
      attachShadow(S, sLink, { cas: new MemCas() })

      // Handshake accepted → authority-side onLink fired with server-assigned trust.
      await until(() => aLink !== undefined)
      expect(aLink!.role).toBe("authority")
      expect(aLink!.trust).toBe("full")
      expect(sLink.role).toBe("shadow")

      bufS.insert("hello")
      bufS.insert(" ws")

      await until(() => bufA.text === "hello ws")
      await until(() => (shadowState(S)!.pending.get("buf-1") ?? []).length === 0)
      expect(bufS.text).toBe(bufA.text)

      sLink.close()
    } finally {
      srv.stop()
    }
  })

  test("token via x-shadow-token header is accepted", async () => {
    let accepted = false
    const srv = serveShadow(() => { accepted = true })
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/`, {
        // @ts-expect-error Bun extension: headers on the client handshake.
        headers: { "x-shadow-token": srv.token },
      })
      await until(() => accepted || ws.readyState === WebSocket.CLOSED)
      expect(accepted).toBe(true)
      ws.close()
    } finally {
      srv.stop()
    }
  })

  test("wrong token: handshake refused, onLink never fires, no ops cross", async () => {
    let accepted = false
    const srv = serveShadow(() => { accepted = true })
    try {
      // Non-WS request: server answers 401 directly.
      const res = await fetch(`http://127.0.0.1:${srv.port}/?token=nope`)
      expect(res.status).toBe(401)

      // WS upgrade with bad token: client sees the socket close without ever opening.
      const sLink = connectWs(`ws://127.0.0.1:${srv.port}/?token=nope`)
      let closed = false
      const orig = sLink._closed.bind(sLink)
      sLink._closed = () => { closed = true; orig() }
      sLink.on(() => { throw new Error("op delivered over an unauthenticated link") })

      await until(() => closed)
      expect(accepted).toBe(false)
    } finally {
      srv.stop()
    }
  })

  test("missing token: handshake refused", async () => {
    let accepted = false
    const srv = serveShadow(() => { accepted = true })
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/`)
      expect(res.status).toBe(401)
      expect(accepted).toBe(false)
    } finally {
      srv.stop()
    }
  })
})
