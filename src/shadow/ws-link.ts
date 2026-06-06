/**
 * `ShadowLink` over a WebSocket — DESIGN.md §Transport, the "attach a second
 * S to an already-running A" row. Server is `Bun.serve` bound to loopback with
 * a one-time bearer token; client is the WHATWG `WebSocket`. Framing is the
 * socket's own message boundary, one JSON-encoded `ShadowOp` per message.
 */

import { randomBytes, timingSafeEqual } from "node:crypto"
import type { ShadowLink, ShadowRole } from "./link"
import type { ShadowOp } from "./ops"

/** What `WsLink` actually needs from the underlying socket. Both Bun's
 *  `ServerWebSocket` and the client `WebSocket` satisfy this. */
type WsLike = {
  send(data: string): unknown
  close(code?: number, reason?: string): void
  readyState?: number
}

export type WsLinkOpts = {
  peerId?: string
  role: ShadowRole
  trust?: "full" | "propose"
  onClose?: () => void
}

/**
 * Transport-agnostic core: wraps a `WsLike`, buffers inbound ops until `on()`
 * is registered (same contract as `StdioLink`), and exposes `_recv`/`_closed`
 * for whichever side owns the socket's event loop to drive.
 */
export class WsLink implements ShadowLink {
  readonly peerId: string
  readonly role: ShadowRole
  readonly trust: "full" | "propose"

  private handler: ((op: ShadowOp) => void) | undefined
  private readonly buffered: ShadowOp[] = []
  private closed = false
  private readonly onClose?: () => void

  constructor(private readonly ws: WsLike, opts: WsLinkOpts) {
    this.peerId = opts.peerId ?? `ws-${Math.random().toString(36).slice(2, 8)}`
    this.role = opts.role
    this.trust = opts.trust ?? "full"
    this.onClose = opts.onClose
  }

  /** Called by the socket owner with one raw message payload. */
  _recv(data: string | ArrayBuffer | Uint8Array): void {
    if (this.closed) return
    const text = typeof data === "string" ? data : new TextDecoder("utf-8").decode(data)
    const op = JSON.parse(text) as ShadowOp
    if (this.handler) this.handler(op)
    else this.buffered.push(op)
  }

  /** Called by the socket owner when the connection drops. Idempotent. */
  _closed(): void {
    if (this.closed) return
    this.closed = true
    this.onClose?.()
  }

  send(op: ShadowOp): void {
    if (this.closed) return
    this.ws.send(JSON.stringify(op))
  }

  on(handler: (op: ShadowOp) => void): void {
    this.handler = handler
    while (this.buffered.length) handler(this.buffered.shift()!)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try { this.ws.close() } catch { /* already closed */ }
    this.onClose?.()
  }
}

// ── Client ──────────────────────────────────────────────────────────────────

/** Wrap a WHATWG `WebSocket` (client side) as a shadow-role link. Ops sent
 *  before the socket reaches OPEN are queued and flushed on `open`. */
export function connectWs(url: string, opts: Omit<WsLinkOpts, "role"> = {}): WsLink {
  const ws = new WebSocket(url)
  const outbox: string[] = []
  // ws.send before OPEN throws; intercept until the socket is ready.
  const wsLike: WsLike = {
    send: data => ws.readyState === WebSocket.OPEN ? ws.send(data) : outbox.push(data),
    close: (code, reason) => ws.close(code, reason),
  }
  const link = new WsLink(wsLike, { ...opts, role: "shadow", peerId: opts.peerId ?? url })
  ws.addEventListener("open", () => { while (outbox.length) ws.send(outbox.shift()!) })
  ws.addEventListener("message", ev => link._recv(ev.data as string))
  ws.addEventListener("close", () => link._closed())
  ws.addEventListener("error", () => link._closed())
  return link
}

// ── Server ──────────────────────────────────────────────────────────────────

export type ServeShadowResult = {
  port: number
  token: string
  /** `ws://127.0.0.1:<port>/?token=<token>` — what `shadow-serve` prints. */
  url: string
  stop: () => void
}

/** Constant-time token check. False on length mismatch (no early-exit leak
 *  beyond length, which is fixed for our tokens anyway). */
function tokenEq(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/**
 * Start a loopback WebSocket server that accepts shadow connections.
 *
 * - Binds `127.0.0.1` only — never exposed off-host.
 * - Generates a 32-byte URL-safe token; the handshake must present it as
 *   `?token=` or the `x-shadow-token` header, else the upgrade is refused
 *   with 401 before any `ShadowOp` can flow.
 * - `onLink` fires once per accepted connection with an authority-role link;
 *   the caller wires that to `attachAuthority`. trust is server-assigned
 *   (DESIGN.md §Link), so a connecting client cannot pick its own.
 * - `port` 0/undefined picks an ephemeral port; the actual port is returned.
 */
export function serveShadow(onLink: (link: WsLink) => void, port = 0): ServeShadowResult {
  const token = randomBytes(32).toString("base64url")

  const server = Bun.serve<{ link: WsLink }>({
    hostname: "127.0.0.1",
    port,
    fetch(req, srv) {
      const presented =
        new URL(req.url).searchParams.get("token") ??
        req.headers.get("x-shadow-token") ??
        ""
      if (!tokenEq(presented, token)) {
        return new Response("unauthorized", { status: 401 })
      }
      // ws.data.link is filled in `open` once we have the ServerWebSocket handle.
      if (srv.upgrade(req, { data: { link: undefined as unknown as WsLink } })) return
      return new Response("upgrade required", { status: 426 })
    },
    websocket: {
      open(ws) {
        const link = new WsLink(ws, {
          role: "authority",
          trust: "full",
          peerId: String(ws.remoteAddress ?? "ws-client"),
          onClose: () => { try { ws.close() } catch { /* gone */ } },
        })
        ws.data.link = link
        onLink(link)
      },
      message(ws, data) {
        ws.data.link?._recv(data)
      },
      close(ws) {
        ws.data.link?._closed()
      },
    },
  })

  const actualPort = server.port!
  return {
    port: actualPort,
    token,
    url: `ws://127.0.0.1:${actualPort}/?token=${token}`,
    stop: () => server.stop(true),
  }
}
