import type { SerializedDisplayModel } from "../display/serialize"
import { DOM_FRAME_ROW_PX, presentDomFrame } from "../display/dom-frame"
import { domKeyFromKeyboardEvent, isDomModifierOnlyKey } from "./dom-key"
import { XtermPaneRegistry } from "./xterm-panes"

const titleEl = document.getElementById("jemacs-title")!
const windowsEl = document.getElementById("jemacs-windows")!
const minibufferCompletionsEl = document.getElementById("jemacs-minibuffer-completions")!
const minibufferEl = document.getElementById("jemacs-minibuffer")!
const echoEl = document.getElementById("jemacs-echo")!
const xtermPanes = new XtermPaneRegistry()
const maxWheelLines = 10

declare global {
  interface Window {
    jemacs: {
      onDisplay(handler: (model: SerializedDisplayModel) => void): () => void
      onTerminalData(handler: (payload: unknown) => void): () => void
      sendInput(payload: unknown): void
      ready(): void
    }
  }
}

function present(model: SerializedDisplayModel): void {
  presentDomFrame(
    { title: titleEl, windows: windowsEl, minibufferCompletions: minibufferCompletionsEl, minibuffer: minibufferEl, echo: echoEl },
    model,
    (windowId, row, col) => {
      window.jemacs.sendInput({ type: "mouse", windowId, row, col, button: 0 })
    },
    (windowId, action, payload) => {
      window.jemacs.sendInput({ type: "pane-action", windowId, action, payload })
    },
    xtermPanes,
  )
}

document.addEventListener("keydown", event => {
  if (event.defaultPrevented) return
  if (isDomModifierOnlyKey(event.key)) return
  window.jemacs.sendInput({ type: "key", key: domKeyFromKeyboardEvent(event) })
  event.preventDefault()
})

document.addEventListener("paste", event => {
  const text = event.clipboardData?.getData("text")
  if (!text) return
  event.preventDefault()
  window.jemacs.sendInput({ type: "paste", text })
})

document.addEventListener("wheel", event => {
  if (event.defaultPrevented) return
  const pane = event.target instanceof Element
    ? event.target.closest<HTMLElement>(".window-pane")
    : null
  const windowId = pane?.dataset.windowId
  if (!windowId) return
  event.preventDefault()
  window.jemacs.sendInput({ type: "wheel", windowId, lines: wheelEventLines(event) })
}, { passive: false })

function wheelEventLines(event: WheelEvent): number {
  const raw = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? event.deltaY
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? event.deltaY * maxWheelLines
      : event.deltaY / DOM_FRAME_ROW_PX
  const direction = Math.sign(raw) || 1
  const lines = Math.max(1, Math.ceil(Math.abs(raw)))
  return direction * Math.min(maxWheelLines, lines)
}

try {
  window.jemacs.onTerminalData(payload => xtermPanes.write(payload))
  window.jemacs.onDisplay(present)
  window.jemacs.ready()
} catch (error) {
  console.error("Jemacs renderer failed to start:", error)
  document.body.textContent = `Renderer error: ${error instanceof Error ? error.message : String(error)}`
}
