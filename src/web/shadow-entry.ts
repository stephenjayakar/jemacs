/// <reference lib="dom" />
/**
 * Browser entry for the shadow (S) side: a full `Editor` running in the page,
 * attached to a remote authority over a WebSocket. Built by
 * `scripts/build-shadow-web.ts` → `dist/shadow-web/editor.js`.
 *
 * Phase-6 (DESIGN.md §Filesystem replica): `find-file` / `dired` /
 * `save-buffer` route through a manifest+CAS-backed `PlatformRuntime`. Content
 * persists across reloads in IndexedDB so reconnect is a `Have`, not a re-stream.
 */

import { Editor } from "../kernel/editor"
import type { BufferModel } from "../kernel/buffer"
import { installDefaultConfig } from "../config"
import { installLisp } from "../../lisp"
import { installDefaultModes } from "../modes/default-modes"
import { attachShadow, resendPending } from "../shadow/shadow"
import type { ShadowLink, ShadowRole } from "../shadow/link"
import type { ShadowOp } from "../shadow/ops"
import { MemCas, type Cas } from "../shadow/cas"
import { ManifestCache } from "../shadow/manifest"
import { createRemoteRuntime, type RemoteRuntime } from "../shadow/remote-runtime"
import { WsLink, connectWs } from "../shadow/ws-link"
import { defvar } from "../runtime/custom"
import { IdbCas } from "./idb-cas"
import { buildLogicalModel } from "../display/logical"
import { webLayout } from "./web-layout"
import { presentDomFrame, type DomFrameTargets } from "../display/dom-frame"
import type { SerializedDisplayModel } from "../display/serialize"
import { domKeyFromKeyboardEvent, isDomModifierOnlyKey } from "../electron/dom-key"

// ── Reconnecting WebSocket link ─────────────────────────────────────────────

export type LinkState = "connecting" | "open" | "down"

/** Auth frame the host gate expects ahead of any ShadowOp. Not part of the
 *  `ShadowOp` union, so it's sent raw on each fresh socket. */
type AuthFrame = { type: "auth"; token: string }

/**
 * A `ShadowLink` that survives socket loss: redials with capped exponential
 * backoff + full jitter, queues outbound ops while not OPEN, and re-ships
 * unacked splices via `resendPending` when a new socket comes up. `state` is
 * what the modeline lighter and the `writeFileText` guard read.
 */
export class ReconnectingLink implements ShadowLink {
  readonly peerId: string
  readonly role: ShadowRole = "shadow"
  readonly trust = "full" as const

  state: LinkState = "connecting"
  /** Mirrors `state !== "open"` so the existing `shadowModeLighter` (which
   *  duck-types `link.partitioned`) reports correctly too. */
  partitioned = true

  private ws?: WebSocket
  private handler?: (op: ShadowOp) => void
  private readonly outbox: string[] = []
  private attempt = 0
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false

  constructor(
    private readonly url: string,
    private readonly opts: {
      token?: string
      onStateChange?: (s: LinkState) => void
      /** Fires on every OPEN after the first — caller wires `resendPending`. */
      onReconnect?: () => void
      baseDelayMs?: number
      maxDelayMs?: number
    } = {},
  ) {
    this.peerId = url
    this.dial()
  }

  private setState(s: LinkState): void {
    if (this.state === s) return
    this.state = s
    this.partitioned = s !== "open"
    this.opts.onStateChange?.(s)
  }

  /** Exponential backoff with full jitter. */
  private nextDelay(): number {
    const base = this.opts.baseDelayMs ?? 250
    const max = this.opts.maxDelayMs ?? 30_000
    const exp = Math.min(max, base * 2 ** this.attempt)
    this.attempt++
    return Math.floor(Math.random() * exp)
  }

  private dial(): void {
    if (this.stopped) return
    this.setState("connecting")
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.addEventListener("open", () => {
      const wasRetry = this.attempt > 0
      this.attempt = 0
      // Auth precedes everything — the host drops the socket otherwise.
      if (this.opts.token) ws.send(JSON.stringify({ type: "auth", token: this.opts.token } satisfies AuthFrame))
      while (this.outbox.length) ws.send(this.outbox.shift()!)
      this.setState("open")
      if (wasRetry) this.opts.onReconnect?.()
    })
    ws.addEventListener("message", ev => {
      const op = JSON.parse(ev.data as string) as ShadowOp
      this.handler?.(op)
    })
    const onDown = () => {
      if (this.ws !== ws) return // superseded by a later dial
      this.ws = undefined
      if (this.stopped) return
      this.setState("down")
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => this.dial(), this.nextDelay())
    }
    ws.addEventListener("close", onDown)
    ws.addEventListener("error", onDown)
  }

  send(op: ShadowOp): void {
    if (this.stopped) return
    const frame = JSON.stringify(op)
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(frame)
    else this.outbox.push(frame)
  }

  on(handler: (op: ShadowOp) => void): void {
    this.handler = handler
  }

  /** Permanent close — cancels pending redial and drops the queue. */
  close(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.outbox.length = 0
    try { this.ws?.close() } catch { /* already gone */ }
    this.setState("down")
  }
}

/** Wrap `runtime.writeFileText` so `save-buffer` fails loudly while the link
 *  is down instead of shipping a Cmd into the void. */
function guardWrites(runtime: RemoteRuntime, link: ReconnectingLink): RemoteRuntime {
  const inner = runtime.writeFileText.bind(runtime)
  runtime.writeFileText = async (path, text) => {
    if (link.state !== "open") {
      throw new Error(`shadow link ${link.state} — save-buffer refused (will not reach authority)`)
    }
    return inner(path, text)
  }
  return runtime
}

/** Process-global: one shadow editor per page, so the lighter reads through a
 *  single ref instead of pushing a fresh closure into `mode-line-misc-info`
 *  per mount. */
let activeLink: ReconnectingLink | undefined

/** Modeline segment for `mode-line-misc-info`. Empty when connected so the
 *  steady state stays quiet. */
export function shadowLinkLighter(_b: BufferModel): string {
  switch (activeLink?.state) {
    case "connecting": return " [⇅ connecting]"
    case "down": return " [⊘ offline]"
    default: return ""
  }
}

// ── Mount ───────────────────────────────────────────────────────────────────

export type ShadowMountOptions = {
  /** Defaults to `ws://${location.host}/ws`. */
  wsUrl?: string
  /** Existing DOM targets; if omitted, the renderer.html ids are looked up. */
  targets?: DomFrameTargets
  /** Skip `installDefaultConfig` (test harness installs its own). */
  bare?: boolean
  /** Override the DOM presenter (tests count calls instead of touching DOM). */
  present?: (targets: DomFrameTargets, model: SerializedDisplayModel) => void
}

function defaultTargets(): DomFrameTargets | undefined {
  const title = document.getElementById("jemacs-title")
  const windows = document.getElementById("jemacs-windows")
  const minibuffer = document.getElementById("jemacs-minibuffer")
  const echo = document.getElementById("jemacs-echo")
  if (!title || !windows || !minibuffer || !echo) return undefined
  return {
    title, windows, minibuffer, echo,
    tabBar: document.getElementById("jemacs-tab-bar") ?? undefined,
    minibufferCompletions: document.getElementById("jemacs-minibuffer-completions") ?? undefined,
  }
}

/** Construct an Editor and connect it as a shadow over `wsUrl`. Returns the
 *  editor + link so a hosting page (or test) can drive it further. */
export function mountShadowEditor(options: ShadowMountOptions = {}): { editor: Editor; link: ReconnectingLink } {
  installDefaultModes()
  const editor = new Editor()
  // installDefaultConfig calls installLisp internally; the bare path is for the
  // bundle test, which only needs `new Editor()` to succeed.
  if (!options.bare) {
    try { installDefaultConfig(editor) }
    catch (err) { console.warn("[shadow] default config partially loaded:", err) }
  }
  ;(globalThis as { __jemacs?: unknown }).__jemacs = { editor, webLayout, buildLogicalModel }

  // ── render pipeline (declared before `link` so onStateChange can call it) ──
  const targets = options.targets ?? defaultTargets()
  const present = options.present ?? presentDomFrame
  let lastMessage = ""
  editor.events.on("message", ({ text }) => { lastMessage = text })
  const render = () => {
    if (!targets) return
    const model = webLayout(buildLogicalModel(editor, { lastMessage, hostLabel: "Jemacs Shadow" }))
    present(targets, model)
  }
  // Coalesce bursts: many `changed` events in one turn → one frame.
  let scheduled = false
  const scheduleRender = () => {
    if (scheduled || !targets) return
    scheduled = true
    const flush = () => { scheduled = false; render() }
    const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => unknown }).requestAnimationFrame
    if (typeof raf === "function") raf(flush)
    else queueMicrotask(flush)
  }
  editor.events.on("changed", scheduleRender)

  // ── link + runtime ────────────────────────────────────────────────────────
  const wsUrl = options.wsUrl ?? `ws://${location.host}/ws`
  const token = (globalThis as { __JEMACS_TOKEN__?: string }).__JEMACS_TOKEN__
  const link = new ReconnectingLink(wsUrl, {
    token,
    onStateChange: s => {
      editor.message(s === "open" ? "[shadow] connected" : `[shadow] ${s}`)
      scheduleRender()
    },
    onReconnect: () => resendPending(editor),
  })
  // IdbCas needs `indexedDB`; fall back to MemCas in test sandboxes that lack it.
  const cas: Cas = typeof indexedDB !== "undefined" ? new IdbCas() : new MemCas()
  const manifest = new ManifestCache()
  const runtime = guardWrites(createRemoteRuntime(link, manifest, cas), link)
  attachShadow(editor, link, { cas, runtime })
  // find-file/dired read `process.cwd()` directly; the host shim returns "/".
  // Redirect the shim through the runtime so they see A's project root once
  // latched, and seed one manifest-req so the latch lands before C-x C-f.
  // `proc.browser` is set only by the host's process shim — never on real Node.
  const proc = (globalThis as { process?: { cwd?: () => string; browser?: boolean } }).process
  if (proc?.browser) proc.cwd = () => runtime.cwd()
  void runtime.readdir(runtime.cwd()).catch(() => {})

  // Surface link state in every buffer's modeline.
  activeLink = link
  const misc = defvar("mode-line-misc-info", [] as Array<(b: BufferModel) => string>).value
  if (!misc.includes(shadowLinkLighter)) misc.push(shadowLinkLighter)

  // <f1> mirrors C-h (Emacs convention) for keys the browser may swallow.
  for (const [k, c] of [["k", "describe-key"], ["c", "describe-key-briefly"], ["b", "describe-bindings"],
                        ["m", "describe-mode"], ["f", "describe-function"], ["v", "describe-variable"]] as const) {
    try { editor.key(`f1 ${k}`, c) } catch { /* command absent in bare mode */ }
  }

  scheduleRender()

  if (targets) {
    // Capture on `window` and preventDefault *before* dispatch so the browser
    // never sees Ctrl+H/Ctrl+D/etc. as its own shortcut.
    const keyTarget: Pick<Window, "addEventListener"> =
      (globalThis as { window?: Window }).window ?? document
    keyTarget.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.defaultPrevented || isDomModifierOnlyKey(ev.key)) return
      ev.preventDefault()
      void editor.handleKey(domKeyFromKeyboardEvent(ev))
    }, true)
  }

  return { editor, link }
}

// ── Global surface ──────────────────────────────────────────────────────────
// Exposed so the bundle test (and a hosting page's inline script) can reach
// these without an import map.

export { Editor, attachShadow, connectWs, WsLink, MemCas, IdbCas, installDefaultConfig, installLisp }

;(globalThis as Record<string, unknown>).JemacsShadow = {
  Editor, attachShadow, connectWs, WsLink, ReconnectingLink, MemCas, IdbCas,
  ManifestCache, createRemoteRuntime,
  installDefaultConfig, installLisp, installDefaultModes,
  buildLogicalModel, webLayout, presentDomFrame,
  mountShadowEditor,
}

// Auto-mount when served inside the standard renderer.html shell. A test page
// without those elements gets the global surface only.
if (typeof document !== "undefined" && document.getElementById("jemacs-root")) {
  mountShadowEditor()
}
