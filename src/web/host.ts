import { randomBytes, timingSafeEqual } from "node:crypto"
import { existsSync, watch as fsWatch } from "node:fs"
import { readFile, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import type { Server, ServerWebSocket } from "bun"
import type { Editor } from "../kernel/editor"
import type {
  DisplayModel,
  HostCapabilities,
  InputHandler,
  NormalizedInput,
  ResizeHandler,
  UiHost,
} from "../display/protocol"
import type { SerializedDisplayModel } from "../display/serialize"
import type { ViewportSize } from "../display/viewport"
import { buildLogicalModel } from "../display/logical"
import { webLayout } from "./web-layout"
import type { FsLike } from "../shadow/manifest"
import type { FsWatcher } from "../shadow/remote-runtime"
import { announceBuffer, attachAuthority } from "../shadow/shadow"
import { WsLink } from "../shadow/ws-link"

export type WebHostOptions = {
  port?: number
  /** ms to wait for the auth message before closing a fresh socket. */
  authTimeoutMs?: number
  /** Serve the browser-shadow bundle (`dist/shadow-web/editor.js`) and bridge
   *  the WebSocket to `attachAuthority` instead of pushing display models. */
  shadow?: boolean
  /** Shadow mode: filesystem root for `manifest-req`/`want`. Defaults to cwd. */
  fsRoot?: string
}

type SocketState = {
  authed: boolean
  authTimer?: ReturnType<typeof setTimeout>
  /** Shadow mode: the per-connection authority link, set after auth. */
  link?: WsLink
  detach?: () => void
}

/** `FsLike` over `node:fs/promises` — what `attachAuthority` reads to answer
 *  `manifest-req` / `want` ops in shadow mode. */
const nodeFs: FsLike = {
  stat: async p => { const s = await stat(p); return { mode: s.mode, size: s.size, mtime: s.mtimeMs } },
  readdir: p => readdir(p),
  readFile: p => readFile(p, "utf8"),
}

/** Recursive `fs.watch` adapted to the `FsWatcher` shape. */
function nodeWatcher(root: string): FsWatcher {
  return onChange => {
    const w = fsWatch(root, { recursive: true }, (_ev, filename) => {
      if (filename) onChange({ path: join(root, filename.toString()) })
    })
    return () => w.close()
  }
}

const STATIC_ROUTES: Record<string, { file: string; type: string }> = {
  "/renderer.js": { file: "client-bridge.js", type: "text/javascript" },
  "/renderer.css": { file: "renderer.css", type: "text/css" },
  "/xterm.css": { file: "xterm.css", type: "text/css" },
}

/** Browser `UiHost`: Bun HTTP server for static assets + WebSocket for the
 *  display-model push / input pull. Loopback-only with a per-process bearer
 *  token (DNS-rebinding hardened: every request's Host header is checked). */
export class WebHost implements UiHost {
  readonly label = "Jemacs Web"
  readonly capabilities: HostCapabilities = {
    unit: "pixels",
    mouse: true,
    clipboard: true,
    osc52: false,
    perFaceFonts: true,
    terminalSurfaces: true,
    terminalRawStreams: false,
  }

  readonly token: string
  readonly port: number
  readonly shadow: boolean

  private readonly server: Server<SocketState>
  private readonly distDir: string
  private readonly sockets = new Set<ServerWebSocket<SocketState>>()
  private readonly inputHandlers: InputHandler[] = []
  private readonly resizeHandlers: ResizeHandler[] = []
  private readonly authTimeoutMs: number
  private readonly fsRoot: string
  private editor?: Editor
  private lastMessage = ""
  private lastModel: SerializedDisplayModel | null = null
  private html = ""

  private constructor(server: Server<SocketState>, token: string, distDir: string, opts: WebHostOptions) {
    this.server = server
    this.token = token
    this.port = server.port ?? 0
    this.distDir = distDir
    this.authTimeoutMs = opts.authTimeoutMs ?? 5000
    this.shadow = opts.shadow ?? false
    this.fsRoot = opts.fsRoot ?? process.cwd()
  }

  static async create(opts: WebHostOptions = {}): Promise<WebHost> {
    const token = randomBytes(32).toString("hex")
    const distDir = opts.shadow ? shadowDistDir() : webDistDir()
    const entry = opts.shadow ? "editor.js" : "client-bridge.js"
    if (!existsSync(join(distDir, entry))) {
      if (opts.shadow) {
        const { buildShadowWeb } = await import("../../scripts/build-shadow-web")
        await buildShadowWeb()
      } else {
        const { buildWebAssets } = await import("../../scripts/build-web")
        await buildWebAssets()
      }
    }
    let host!: WebHost
    const server = Bun.serve<SocketState>({
      port: opts.port ?? 0,
      hostname: "127.0.0.1",
      fetch: (req, srv) => host.handleFetch(req, srv),
      websocket: {
        open: ws => host.wsOpen(ws),
        message: (ws, msg) => host.wsMessage(ws, msg),
        close: ws => host.wsClose(ws),
      },
    })
    host = new WebHost(server, token, distDir, opts)
    host.html = await host.loadHtml()
    return host
  }

  /** Gives `present()` access to the editor so it can rebuild from
   *  `LogicalModel` (bypassing the char-grid layout `bindJemacsHost` produced). */
  attachEditor(editor: Editor): void {
    this.editor = editor
    editor.events.on("message", ({ text }) => { this.lastMessage = text })
  }

  async start(): Promise<void> { /* server already listening */ }

  destroy(): void {
    for (const ws of this.sockets) ws.close()
    this.sockets.clear()
    this.server.stop(true)
  }

  getViewport(): ViewportSize { return { rows: 48, cols: 160 } }

  present(_model: DisplayModel): void {
    if (!this.editor || this.shadow) return
    const logical = buildLogicalModel(this.editor, {
      lastMessage: this.lastMessage,
      hostLabel: this.label,
    })
    this.lastModel = webLayout(logical, this.getViewport())
    this.broadcast(this.lastModel)
  }

  onInput(handler: InputHandler): void { this.inputHandlers.push(handler) }
  onResize(handler: ResizeHandler): void { this.resizeHandlers.push(handler) }

  // ——— HTTP ———

  private handleFetch(req: Request, server: Server<SocketState>): Response | undefined {
    if (!this.hostAllowed(req)) return new Response("forbidden", { status: 403 })
    const url = new URL(req.url)
    if (url.pathname === "/ws") {
      if (server.upgrade(req, { data: { authed: false } })) return undefined
      return new Response("upgrade required", { status: 426 })
    }
    if (url.pathname === "/") {
      return new Response(this.html, { headers: { "Content-Type": "text/html; charset=utf-8" } })
    }
    if (this.shadow && url.pathname === "/editor.js") {
      return new Response(Bun.file(join(this.distDir, "editor.js")), {
        headers: { "Content-Type": "text/javascript" },
      })
    }
    const route = STATIC_ROUTES[url.pathname]
    if (route) {
      return new Response(Bun.file(join(this.distDir, route.file)), {
        headers: { "Content-Type": route.type },
      })
    }
    return new Response("not found", { status: 404 })
  }

  /** DNS-rebinding guard: even though we bind 127.0.0.1, a hostile page can
   *  point `evil.com` at 127.0.0.1 and read the token out of `/`. */
  private hostAllowed(req: Request): boolean {
    const host = req.headers.get("host")
    if (!host) return false
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`
  }

  private async loadHtml(): Promise<string> {
    const inject = `<script>window.__JEMACS_TOKEN__=${JSON.stringify(this.token)}</script>`
    if (this.shadow) {
      // The shadow bundle auto-mounts when it finds these ids; the editor
      // renders locally so no thin-client CSS/shell is needed.
      return `<!doctype html><html><head><meta charset="utf-8"><title>Jemacs Shadow</title>${inject}</head>`
        + `<body><div id="jemacs-root"><div id="jemacs-title"></div><div id="jemacs-windows"></div>`
        + `<div id="jemacs-minibuffer"></div><div id="jemacs-echo"></div></div>`
        + `<script type="module" src="/editor.js"></script></body></html>`
    }
    const raw = await readFile(join(this.distDir, "renderer.html"), "utf8")
    return raw.replace("</head>", `  ${inject}\n</head>`)
  }

  // ——— WebSocket ———

  private wsOpen(ws: ServerWebSocket<SocketState>): void {
    ws.data.authTimer = setTimeout(() => {
      if (!ws.data.authed) ws.close(1008, "auth timeout")
    }, this.authTimeoutMs)
  }

  private wsMessage(ws: ServerWebSocket<SocketState>, raw: string | Buffer): void {
    if (ws.data.link) { ws.data.link._recv(raw); return }
    let msg: unknown
    try { msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) }
    catch { ws.close(1003, "bad json"); return }
    if (!ws.data.authed) {
      if (!this.checkAuth(msg)) { ws.close(1008, "auth failed"); return }
      ws.data.authed = true
      if (ws.data.authTimer) clearTimeout(ws.data.authTimer)
      this.sockets.add(ws)
      if (this.shadow) { this.attachShadowLink(ws); return }
      if (this.lastModel) ws.send(JSON.stringify(this.lastModel))
      return
    }
    const input = msg as NormalizedInput
    if (!input || typeof input !== "object" || !("type" in input)) return
    for (const handler of this.inputHandlers) void handler(input)
  }

  /** Shadow mode: wrap the authed socket as an authority-role `WsLink` and
   *  let `attachAuthority` serve manifest/chunks from `fsRoot`. */
  private attachShadowLink(ws: ServerWebSocket<SocketState>): void {
    if (!this.editor) { ws.close(1011, "no editor"); return }
    const link = new WsLink(ws, { role: "authority", trust: "full", peerId: String(ws.remoteAddress ?? "ws") })
    ws.data.link = link
    ws.data.detach = attachAuthority(this.editor, link, {
      fs: nodeFs,
      fsRoot: this.fsRoot,
      watcher: nodeWatcher(this.fsRoot),
    })
    for (const buf of this.editor.buffers.values()) announceBuffer(this.editor, buf.id)
  }

  private wsClose(ws: ServerWebSocket<SocketState>): void {
    if (ws.data.authTimer) clearTimeout(ws.data.authTimer)
    ws.data.link?._closed()
    ws.data.detach?.()
    this.sockets.delete(ws)
  }

  private checkAuth(msg: unknown): boolean {
    if (!msg || typeof msg !== "object") return false
    const m = msg as { type?: unknown; token?: unknown }
    if (m.type !== "auth" || typeof m.token !== "string") return false
    const a = Buffer.from(m.token, "utf8")
    const b = Buffer.from(this.token, "utf8")
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  private broadcast(model: SerializedDisplayModel): void {
    const payload = JSON.stringify(model)
    for (const ws of this.sockets) {
      if (ws.data.authed) ws.send(payload)
    }
  }
}

export async function createWebHost(opts: WebHostOptions = {}): Promise<WebHost> {
  return WebHost.create(opts)
}

function webDistDir(): string {
  const home = process.env.JEMACS_HOME
  if (home) return join(home, "dist/web")
  return join(import.meta.dirname, "..", "..", "dist", "web")
}

function shadowDistDir(): string {
  const home = process.env.JEMACS_HOME
  if (home) return join(home, "dist/shadow-web")
  return join(import.meta.dirname, "..", "..", "dist", "shadow-web")
}
