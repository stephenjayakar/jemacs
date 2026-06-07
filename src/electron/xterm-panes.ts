import { Terminal } from "@xterm/xterm"
import { WebglAddon } from "@xterm/addon-webgl"
import type { SerializedPane, SerializedDisplayModel } from "../display/serialize"

type TerminalDataPayload = {
  bufferId: string
  data: string
}

type XtermPaneState = {
  term: Terminal
  container: HTMLDivElement
  opened: boolean
  pending: string
  rows: number
  cols: number
}

const MAX_PENDING_BYTES = 1024 * 1024

export class XtermPaneRegistry {
  private readonly panes = new Map<string, XtermPaneState>()

  write(payload: unknown): void {
    if (!isTerminalDataPayload(payload)) return
    const state = this.ensure(payload.bufferId)
    if (!state.opened) {
      state.pending = trimPending(state.pending + payload.data)
      return
    }
    state.term.write(payload.data)
  }

  mount(body: HTMLElement, pane: SerializedPane, theme?: SerializedDisplayModel["theme"]): boolean {
    const surface = pane.terminalSurface
    if (!surface) return false

    const state = this.ensure(pane.bufferId)
    applyTheme(state.term, theme)
    state.container.className = "xterm-pane"
    body.classList.add("xterm-surface")
    body.replaceChildren(state.container)

    const rows = Math.max(1, surface.rows)
    const cols = Math.max(1, surface.cols)
    if (!state.opened) {
      state.rows = rows
      state.cols = cols
      requestAnimationFrame(() => {
        if (state.opened) return
        state.term.open(state.container)
        loadWebgl(state.term)
        state.opened = true
        state.term.resize(cols, rows)
        if (state.pending) {
          const pending = state.pending
          state.pending = ""
          state.term.write(pending)
        }
      })
      return true
    }

    if (rows !== state.rows || cols !== state.cols) {
      state.rows = rows
      state.cols = cols
      state.term.resize(cols, rows)
    }
    return true
  }

  private ensure(bufferId: string): XtermPaneState {
    let state = this.panes.get(bufferId)
    if (state) return state
    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: "Fira Code, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      rows: 24,
      cols: 80,
      scrollback: 10_000,
      theme: {
        background: "#1e1e1e",
        foreground: "#d4d4d4",
      },
    })
    state = {
      term,
      container: document.createElement("div"),
      opened: false,
      pending: "",
      rows: 24,
      cols: 80,
    }
    this.panes.set(bufferId, state)
    return state
  }
}

function isTerminalDataPayload(value: unknown): value is TerminalDataPayload {
  if (!value || typeof value !== "object") return false
  const payload = value as Partial<TerminalDataPayload>
  return typeof payload.bufferId === "string" && typeof payload.data === "string"
}

function trimPending(value: string): string {
  if (value.length <= MAX_PENDING_BYTES) return value
  return value.slice(value.length - MAX_PENDING_BYTES)
}

function loadWebgl(term: Terminal): void {
  try {
    const addon = new WebglAddon()
    addon.onContextLoss(() => addon.dispose())
    term.loadAddon(addon)
  } catch (error) {
    console.warn("xterm WebGL renderer unavailable; using default renderer", error)
  }
}

function applyTheme(term: Terminal, theme?: SerializedDisplayModel["theme"]): void {
  const defaultFace = theme?.faces.default
  const nextTheme = {
    background: defaultFace?.bg ?? "#1e1e1e",
    foreground: defaultFace?.fg ?? "#d4d4d4",
    cursor: defaultFace?.fg ?? "#d4d4d4",
  }
  term.options.theme = nextTheme
  if (defaultFace?.family) term.options.fontFamily = defaultFace.family
  if (defaultFace?.height != null) term.options.fontSize = defaultFace.height / 10
}
