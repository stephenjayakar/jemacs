import { app, BrowserWindow, ipcMain } from "electron"
import path from "node:path"
import { serializeDisplayModel, type SerializedDisplayModel } from "../display/serialize"
import type {
  DisplayModel,
  InputHandler,
  NormalizedInput,
  ResizeHandler,
  UiHost,
} from "../display/protocol"
import { contentAreaLines, defaultTerminalRows, type ViewportSize } from "../display/viewport"
import type { KeyEventLike } from "../kernel/keymap"

const ROW_PX = 18
const COL_PX = 9

export class ElectronHost implements UiHost {
  readonly label = "Jemacs GUI"
  readonly capabilities = {
    unit: "pixels" as const,
    mouse: true,
    clipboard: true,
    osc52: false,
    perFaceFonts: true,
    terminalSurfaces: true,
  }

  private window: BrowserWindow | null = null
  private inputHandlers: InputHandler[] = []
  private resizeHandlers: ResizeHandler[] = []
  private ipcReady = false
  private rendererReady = false
  private lastDisplay: SerializedDisplayModel | null = null
  private onRendererReadyHandlers: Array<() => void> = []

  async start(): Promise<void> {
    await app.whenReady()
    this.installIpc()
    const electronDir = electronDistDir()
    const rendererHtml = path.join(electronDir, "renderer.html")
    this.window = new BrowserWindow({
      width: 960,
      height: 720,
      title: "Jemacs",
      webPreferences: {
        preload: path.join(electronDir, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    await this.window.loadFile(rendererHtml)
    this.window.on("resize", () => {
      for (const handler of this.resizeHandlers) handler(this.getViewport())
    })
    app.on("window-all-closed", () => {
      if (process.platform !== "darwin") app.quit()
    })
  }

  destroy(): void {
    this.window?.close()
    this.window = null
    app.quit()
  }

  getViewport(): ViewportSize {
    if (!this.window) return { rows: defaultTerminalRows() }
    const [width, height] = this.window.getContentSize()
    return {
      rows: Math.max(24, Math.floor(height / ROW_PX)),
      cols: Math.max(80, Math.floor(width / COL_PX)),
    }
  }

  /** Called when the renderer has registered `onDisplay` (avoids losing the first frame). */
  onRendererReady(handler: () => void): void {
    this.onRendererReadyHandlers.push(handler)
    if (this.rendererReady) handler()
  }

  present(model: DisplayModel): void {
    this.lastDisplay = serializeDisplayModel(model)
    this.pushDisplay(model.hostLabel)
  }

  private pushDisplay(title?: string): void {
    if (!this.window?.webContents || !this.lastDisplay || !this.rendererReady) return
    this.window.webContents.send("jemacs:display", this.lastDisplay)
    if (title) this.window.setTitle(title)
  }

  onInput(handler: InputHandler): void {
    this.inputHandlers.push(handler)
  }

  onResize(handler: ResizeHandler): void {
    this.resizeHandlers.push(handler)
  }

  private installIpc(): void {
    if (this.ipcReady) return
    this.ipcReady = true
    ipcMain.on("jemacs:input", (_event, payload: NormalizedInput) => {
      for (const handler of this.inputHandlers) void handler(payload)
    })
    ipcMain.on("jemacs:ready", event => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win) win.setTitle("Jemacs")
      this.rendererReady = true
      this.pushDisplay(this.lastDisplay?.hostLabel ?? "Jemacs")
      for (const handler of this.onRendererReadyHandlers) handler()
    })
  }
}

/** Map DOM key payload from the renderer to kernel key representation. */
export function domKeyToKeyEventLike(detail: {
  name: string
  sequence?: string
  ctrl?: boolean
  meta?: boolean
  super?: boolean
  shift?: boolean
}): KeyEventLike {
  return {
    name: detail.name,
    sequence: detail.sequence ?? detail.name,
    raw: detail.sequence ?? detail.name,
    ctrl: detail.ctrl,
    meta: detail.meta,
    super: detail.super,
    shift: detail.shift,
  }
}

export function guiContentAreaLines(host: ElectronHost): number {
  return contentAreaLines(host.getViewport().rows)
}

function electronDistDir(): string {
  const home = process.env.JEMACS_HOME
  if (home) return path.join(home, "dist/electron")
  // Fallback when JEMACS_HOME is unset (tests / direct electron dist/main-electron.js).
  return path.join(import.meta.dirname, "..", "..", "dist", "electron")
}
