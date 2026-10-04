import type { SerializedDisplayModel } from "../display/serialize"
import { DOM_FRAME_ROW_PX, presentDomFrame } from "../display/dom-frame"
import { domKeyFromKeyboardEvent, domKeyPlatform, isDomHideShortcut, isDomModifierOnlyKey, isDomPasteShortcut } from "./dom-key"
import { XtermPaneRegistry } from "./xterm-panes"
import { FontMeasurer } from "../display/font-measure"

const titleEl = document.getElementById("jemacs-title")!
const tabBarEl = document.getElementById("jemacs-tab-bar")!
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
      sendFontMetrics?(batch: unknown, reset: boolean): void
      readClipboardText(): string | Promise<string>
      readClipboardImage?(): Promise<string>
      hideApplication?(): void
      ready(): void
    }
  }
}

const fontMeasurer = new FontMeasurer((batch, reset) => window.jemacs.sendFontMetrics?.(batch, reset))

function present(model: SerializedDisplayModel): void {
  presentDomFrame(
    { title: titleEl, tabBar: tabBarEl, windows: windowsEl, minibufferCompletions: minibufferCompletionsEl, minibuffer: minibufferEl, echo: echoEl },
    model,
    (windowId, row, col, drag) => {
      window.jemacs.sendInput({ type: "mouse", windowId, row, col, button: 0, drag })
    },
    (windowId, action, payload) => {
      window.jemacs.sendInput({ type: "pane-action", windowId, action, payload })
    },
    xtermPanes,
    col => {
      window.jemacs.sendInput({ type: "tab-bar", col })
    },
  )
  // After painting: a font first drawn in this frame is measured now, and the
  // kernel re-wraps with exact widths on the next redisplay.
  fontMeasurer.observe(model)
}
document.addEventListener("keydown", async event => {
  if (event.defaultPrevented) return
  if (isDomModifierOnlyKey(event.key)) return
  if (isDomPasteShortcut(event, domKeyPlatform(navigator.userAgent))) {
    event.preventDefault()
    const text = await window.jemacs.readClipboardText()
    if (text) {
      window.jemacs.sendInput({ type: "paste", text })
      return
    }
    // No text: a screenshot or copied image goes to the mode's yank-media handler.
    const data = await window.jemacs.readClipboardImage?.()
    if (data) window.jemacs.sendInput({ type: "paste-media", mime: "image/png", data })
    return
  }
  if (window.jemacs.hideApplication && isDomHideShortcut(event, domKeyPlatform(navigator.userAgent))) {
    event.preventDefault()
    window.jemacs.hideApplication()
    return
  }
  window.jemacs.sendInput({ type: "key", key: domKeyFromKeyboardEvent(event) })
  event.preventDefault()
})

document.addEventListener("paste", event => {
  const text = event.clipboardData?.getData("text")
  if (text) {
    event.preventDefault()
    window.jemacs.sendInput({ type: "paste", text })
    return
  }
  const image = Array.from(event.clipboardData?.files ?? []).find(file => file.type.startsWith("image/"))
  if (!image) return
  event.preventDefault()
  void image.arrayBuffer().then(bytes => {
    window.jemacs.sendInput({ type: "paste-media", mime: image.type, data: base64(new Uint8Array(bytes)) })
  })
})

function base64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

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
