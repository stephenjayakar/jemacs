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
import { installDefaultConfig } from "../config"
import { installLisp } from "../../lisp"
import { installDefaultModes } from "../modes/default-modes"
import { attachShadow } from "../shadow/shadow"
import { MemCas, type Cas } from "../shadow/cas"
import { ManifestCache } from "../shadow/manifest"
import { createRemoteRuntime } from "../shadow/remote-runtime"
import { WsLink, connectWs } from "../shadow/ws-link"
import { IdbCas } from "./idb-cas"
import { buildLogicalModel } from "../display/logical"
import { webLayout } from "./web-layout"
import { presentDomFrame, type DomFrameTargets } from "../display/dom-frame"
import { domKeyFromKeyboardEvent, isDomModifierOnlyKey } from "../electron/dom-key"

export type ShadowMountOptions = {
  /** Defaults to `ws://${location.host}/shadow`. */
  wsUrl?: string
  /** Existing DOM targets; if omitted, the renderer.html ids are looked up. */
  targets?: DomFrameTargets
  /** Skip `installDefaultConfig` (test harness installs its own). */
  bare?: boolean
}

function defaultTargets(): DomFrameTargets | undefined {
  const title = document.getElementById("jemacs-title")
  const windows = document.getElementById("jemacs-windows")
  const minibuffer = document.getElementById("jemacs-minibuffer")
  const echo = document.getElementById("jemacs-echo")
  if (!title || !windows || !minibuffer || !echo) return undefined
  return {
    title, windows, minibuffer, echo,
    minibufferCompletions: document.getElementById("jemacs-minibuffer-completions") ?? undefined,
  }
}

/** Construct an Editor and connect it as a shadow over `wsUrl`. Returns the
 *  editor + link so a hosting page (or test) can drive it further. */
export function mountShadowEditor(options: ShadowMountOptions = {}): { editor: Editor; link: WsLink } {
  installDefaultModes()
  const editor = new Editor()
  // installDefaultConfig calls installLisp internally; the bare path is for the
  // bundle test, which only needs `new Editor()` to succeed.
  if (!options.bare) {
    try { installDefaultConfig(editor) }
    catch (err) { console.warn("[shadow] default config partially loaded:", err) }
  }

  const wsUrl = options.wsUrl ?? `ws://${location.host}/ws`
  const link = connectWs(wsUrl)
  // Host gates the socket on `{type:"auth",token}` before forwarding ShadowOps;
  // connectWs queues until OPEN, so sending this first guarantees it lands first.
  const token = (globalThis as { __JEMACS_TOKEN__?: string }).__JEMACS_TOKEN__
  if (token) link.send({ type: "auth", token } as unknown as Parameters<typeof link.send>[0])
  // IdbCas needs `indexedDB`; fall back to MemCas in test sandboxes that lack it.
  const cas: Cas = typeof indexedDB !== "undefined" ? new IdbCas() : new MemCas()
  const manifest = new ManifestCache()
  const runtime = createRemoteRuntime(link, manifest, cas)
  attachShadow(editor, link, { cas, runtime })

  const targets = options.targets ?? defaultTargets()
  let lastMessage = ""
  editor.events.on("message", ({ text }) => { lastMessage = text })
  const render = () => {
    if (!targets) return
    const model = webLayout(buildLogicalModel(editor, { lastMessage, hostLabel: "Jemacs Shadow" }))
    presentDomFrame(targets, model)
  }
  editor.events.on("changed", () => render())
  render()

  if (targets) {
    document.addEventListener("keydown", ev => {
      if (ev.defaultPrevented || isDomModifierOnlyKey(ev.key)) return
      void editor.handleKey(domKeyFromKeyboardEvent(ev))
      ev.preventDefault()
    })
  }

  return { editor, link }
}

// ── Global surface ──────────────────────────────────────────────────────────
// Exposed so the bundle test (and a hosting page's inline script) can reach
// these without an import map.

export { Editor, attachShadow, connectWs, WsLink, MemCas, IdbCas, installDefaultConfig, installLisp }

;(globalThis as Record<string, unknown>).JemacsShadow = {
  Editor, attachShadow, connectWs, WsLink, MemCas, IdbCas,
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
