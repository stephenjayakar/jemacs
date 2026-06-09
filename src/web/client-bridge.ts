/// <reference lib="dom" />
import type { SerializedDisplayModel } from "../display/serialize"

declare global {
  interface Window {
    __JEMACS_TOKEN__?: string
  }
}

type DisplayHandler = (model: SerializedDisplayModel) => void
type TerminalDataHandler = (payload: unknown) => void

const token = window.__JEMACS_TOKEN__
const ws = new WebSocket(`ws://${location.host}/ws`)
let displayHandler: DisplayHandler | null = null
let terminalDataHandler: TerminalDataHandler | null = null
const pending: SerializedDisplayModel[] = []

ws.onopen = () => {
  ws.send(JSON.stringify({ type: "auth", token }))
}
ws.onmessage = event => {
  const model = JSON.parse(String(event.data)) as SerializedDisplayModel
  if (displayHandler) displayHandler(model)
  else pending.push(model)
}
ws.onclose = () => {
  document.title = "Jemacs (disconnected)"
}

// Same surface as the Electron preload so `renderer.ts` is unchanged.
window.jemacs = {
  onDisplay(handler: DisplayHandler): () => void {
    displayHandler = handler
    for (const m of pending.splice(0)) handler(m)
    return () => { if (displayHandler === handler) displayHandler = null }
  },
  onTerminalData(handler: TerminalDataHandler): () => void {
    terminalDataHandler = handler
    return () => { if (terminalDataHandler === handler) terminalDataHandler = null }
  },
  sendInput(payload: unknown): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
  },
  ready(): void { /* no-op: server pushes on auth */ },
}

// `renderer.ts` reads `window.jemacs` at module-eval time. Static `import` is
// hoisted above this body, so use a dynamic import to guarantee ordering.
void import("../electron/renderer")
