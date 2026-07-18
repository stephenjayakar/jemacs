/// <reference lib="dom" />
import type { SerializedDisplayModel, SerializedPane, SerializedWindowNode } from "../display/serialize"
import { renderCaret } from "../display/dom-frame"

declare global {
  interface Window {
    __JEMACS_TOKEN__?: string
  }
}

type DisplayHandler = (model: SerializedDisplayModel) => void
type TerminalDataHandler = (payload: unknown) => void
type Cursor = { row: number; colOffset: number }
type Motion = "left" | "right" | "up" | "down" | "home" | "end"
type KeyPayload = { type: "key"; key: { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean; super?: boolean } }

export type JemacsBridge = Window["jemacs"]

const token = window.__JEMACS_TOKEN__
let displayHandler: DisplayHandler | null = null
let terminalDataHandler: TerminalDataHandler | null = null
const pending: SerializedDisplayModel[] = []

/** Optimistic-caret state captured after each authoritative display so motion
 *  keys can repaint the caret immediately, before the server round-trip. */
let lastModel: SerializedDisplayModel | null = null
let lastCursor: Cursor | null = null
let lastBody: HTMLElement | null = null
let lastRows: HTMLElement[] = []
/** Logical lines of the selected pane (model-derived, pre-wrap). Prediction
 *  reads lengths from here, not from `.body-row` `textContent`, so a CSS-wrapped
 *  row or a DOM that hasn't repainted yet can't skew the column math. */
let lastLines: string[] = []
let lastFg: string | undefined

function selectedPane(node: SerializedWindowNode): SerializedPane | null {
  if (node.kind === "leaf") return node.pane.selected ? node.pane : null
  return selectedPane(node.first) ?? selectedPane(node.second)
}

function captureCaretState(model: SerializedDisplayModel): void {
  lastModel = model
  const pane = selectedPane(model.windows)
  lastCursor = pane?.cursor ? { ...pane.cursor } : null
  lastLines = pane ? pane.body.chunks.map(c => c.text).join("").split("\n") : []
  lastFg = model.theme.faces.default?.fg
  lastBody = document.querySelector<HTMLElement>(".window-pane.selected .window-body")
  lastRows = lastBody ? [...lastBody.querySelectorAll<HTMLElement>(".body-row")] : []
}

function minibufferActive(model: SerializedDisplayModel): boolean {
  return model.minibuffer.chunks.some(c => c.text.trim().length > 0)
}

function classifyMotion(key: KeyPayload["key"]): Motion | null {
  if (key.meta || key.shift || key.super) return null
  const bare = !key.ctrl
  if (bare) {
    if (key.name === "left") return "left"
    if (key.name === "right") return "right"
    if (key.name === "up") return "up"
    if (key.name === "down") return "down"
    if (key.name === "home") return "home"
    if (key.name === "end") return "end"
    return null
  }
  if (key.name === "b") return "left"
  if (key.name === "f") return "right"
  if (key.name === "p") return "up"
  if (key.name === "n") return "down"
  if (key.name === "a") return "home"
  if (key.name === "e") return "end"
  return null
}

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff

/** Pure caret prediction over logical `lines`. `colOffset` is in UTF-16 code
 *  units (matching `renderCaret`'s Range math); left/right step one *codepoint*
 *  so the caret never lands between a surrogate pair. */
export function predictCursor(cursor: Cursor, motion: Motion, lines: readonly string[]): Cursor {
  let { row, colOffset } = cursor
  const maxRow = Math.max(0, lines.length - 1)
  const line = (i: number) => lines[i] ?? ""
  const len = (i: number) => line(i).length
  // up/down keep `colOffset` but the destination line may have a surrogate pair
  // straddling that column; snap left so the caret never sits between halves.
  const clamp = (i: number, col: number) => {
    let c = Math.min(col, len(i))
    if (isLowSurrogate(line(i).charCodeAt(c))) c--
    return c
  }
  switch (motion) {
    case "left":
      if (colOffset > 0) {
        colOffset -= isLowSurrogate(line(row).charCodeAt(colOffset - 1)) ? 2 : 1
      } else if (row > 0) { row--; colOffset = len(row) }
      break
    case "right":
      if (colOffset < len(row)) {
        colOffset += isHighSurrogate(line(row).charCodeAt(colOffset)) ? 2 : 1
      } else if (row < maxRow) { row++; colOffset = 0 }
      break
    case "up":
      if (row > 0) row--
      colOffset = clamp(row, colOffset)
      break
    case "down":
      if (row < maxRow) row++
      colOffset = clamp(row, colOffset)
      break
    case "home":
      colOffset = 0
      break
    case "end":
      colOffset = len(row)
      break
  }
  return { row, colOffset: Math.max(0, colOffset) }
}

function applyOptimisticCaret(payload: unknown): void {
  if (!lastModel || !lastCursor || !lastBody || !lastRows.length) return
  if (minibufferActive(lastModel)) return
  const p = payload as Partial<KeyPayload> | null
  if (!p || p.type !== "key" || !p.key) return
  const motion = classifyMotion(p.key)
  if (!motion) return
  const predicted = predictCursor(lastCursor, motion, lastLines)
  for (const old of lastBody.querySelectorAll(".jemacs-caret")) old.remove()
  renderCaret(lastBody, lastRows, predicted, lastFg, "predicted")
  lastCursor = predicted
}

// ── Connection ──────────────────────────────────────────────────────────────

const RECONNECT_BASE_MS = 250
const RECONNECT_MAX_MS = 10_000
let ws: WebSocket
let reconnectDelay = RECONNECT_BASE_MS

function connect(): void {
  ws = new WebSocket(`ws://${location.host}/ws`)
  ws.onopen = () => {
    reconnectDelay = RECONNECT_BASE_MS
    ws.send(JSON.stringify({ type: "auth", token }))
  }
  ws.onmessage = event => {
    const model = JSON.parse(String(event.data)) as SerializedDisplayModel
    if (displayHandler) {
      displayHandler(model)
      captureCaretState(model)
    } else pending.push(model)
  }
  // No correction frames will arrive once the socket is gone, so drop the
  // prediction baseline; `sendInput` also gates on OPEN so a held arrow key
  // can't keep walking the caret while the keystrokes are being dropped.
  ws.onclose = () => {
    document.title = "Jemacs (disconnected)"
    lastModel = null
    lastCursor = null
    const jitter = Math.random() * reconnectDelay
    setTimeout(connect, reconnectDelay + jitter)
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
  }
  ws.onerror = () => { try { ws.close() } catch { /* already closing */ } }
}
connect()

// Same surface as the Electron preload so `renderer.ts` is unchanged.
window.jemacs = {
  onDisplay(handler: DisplayHandler): () => void {
    displayHandler = handler
    for (const m of pending.splice(0)) {
      handler(m)
      captureCaretState(m)
    }
    return () => { if (displayHandler === handler) displayHandler = null }
  },
  onTerminalData(handler: TerminalDataHandler): () => void {
    terminalDataHandler = handler
    return () => { if (terminalDataHandler === handler) terminalDataHandler = null }
  },
  sendInput(payload: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(payload))
    applyOptimisticCaret(payload)
  },
  readClipboardText(): Promise<string> {
    return navigator.clipboard.readText().catch(() => "")
  },
  ready(): void { /* no-op: server pushes on auth */ },
}

// `renderer.ts` reads `window.jemacs` at module-eval time. Static `import` is
// hoisted above this body, so use a dynamic import to guarantee ordering.
// Gate on the shell being present so test sandboxes (which provide a stub
// `document` with no #jemacs-windows) don't pull in the full DOM renderer.
if (document.getElementById("jemacs-windows")) void import("../electron/renderer")
