import { app, BrowserWindow, clipboard, globalShortcut, ipcMain } from "electron"
import path from "node:path"
import { serializeDisplayModel, type SerializedDisplayModel } from "../display/serialize"
import type {
  DisplayModel,
  InputHandler,
  NormalizedInput,
  ResizeHandler,
  TerminalData,
  UiHost,
} from "../display/protocol"
import { contentAreaLines, defaultTerminalRows, type ViewportSize } from "../display/viewport"
import type { KeyEventLike } from "../kernel/keymap"
import { DOM_FRAME_BODY_FONT_PX, DOM_FRAME_LINE_HEIGHT_RATIO } from "../display/dom-frame"
import { appName } from "../runtime/app-name"

// Must match what the renderer actually draws, or the kernel lays out a different
// number of rows than the DOM has room for. A surplus leaves the body permanently
// at the overflow threshold, so the scrollbar toggles between frames and the pane
// flickers -- most visibly at the bottom of a buffer.
const ROW_PX = DOM_FRAME_BODY_FONT_PX * DOM_FRAME_LINE_HEIGHT_RATIO
const COL_PX = 9

/** OS-wide hotkey that raises a jemacs GUI window from any app. */
const DEFAULT_GLOBAL_ACTIVATE_ACCELERATOR = "Command+Alt+Y"

export class ElectronHost implements UiHost {
  readonly label = "Jemacs GUI"
  readonly capabilities = {
    unit: "pixels" as const,
    mouse: true,
    clipboard: true,
    osc52: false,
    perFaceFonts: true,
    terminalSurfaces: true,
    terminalRawStreams: true,
    richTables: true,
    webSurfaces: true,
  }

  private window: BrowserWindow | null = null
  private inputHandlers: InputHandler[] = []
  private resizeHandlers: ResizeHandler[] = []
  private ipcReady = false
  private rendererReady = false
  private lastDisplay: SerializedDisplayModel | null = null
  private onRendererReadyHandlers: Array<() => void> = []
  /** OS window per editor frame; the kernel's frame list is the source of truth. */
  private readonly frameWindows = new Map<string, BrowserWindow>()
  private frameClosedHandlers: Array<(frameId: string) => void> = []
  /** Most recently focused jemacs window; the global hotkey raises this one. */
  private lastFocusedWindow: BrowserWindow | null = null
  private globalAccelerator: string | null = null

  async start(): Promise<void> {
    await app.whenReady()
    this.installIpc()
    const electronDir = electronDistDir()
    const rendererHtml = path.join(electronDir, "renderer.html")
    this.window = new BrowserWindow({
      width: 960,
      height: 720,
      title: appName(),
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
    this.trackFocus(this.window)
    this.registerGlobalActivation()
    app.on("window-all-closed", () => {
      if (process.platform !== "darwin") app.quit()
    })
    app.on("will-quit", () => this.unregisterGlobalActivation())
  }

  destroy(): void {
    this.unregisterGlobalActivation()
    this.window?.close()
    this.window = null
    app.quit()
  }

  /**
   * Register the OS-wide activation hotkey (default Cmd-Alt-Y). Set
   * JEMACS_GUI_GLOBAL_HOTKEY to another Electron accelerator to change it, or to
   * an empty string to disable. Registration fails silently when another app
   * already owns the combo -- a missing hotkey must not stop the editor booting.
   */
  private registerGlobalActivation(): void {
    const accelerator = process.env.JEMACS_GUI_GLOBAL_HOTKEY ?? DEFAULT_GLOBAL_ACTIVATE_ACCELERATOR
    if (!accelerator) return
    try {
      if (globalShortcut.register(accelerator, () => this.activate())) {
        this.globalAccelerator = accelerator
      } else {
        console.error(`jemacs: global hotkey ${accelerator} is already taken`)
      }
    } catch (error) {
      console.error(`jemacs: could not register global hotkey ${accelerator}:`, error)
    }
  }

  private unregisterGlobalActivation(): void {
    if (!this.globalAccelerator) return
    globalShortcut.unregister(this.globalAccelerator)
    this.globalAccelerator = null
  }

  /** Bring a jemacs window to the front from wherever the user currently is. */
  private activate(): void {
    const win = this.activationTarget()
    if (!win) return
    if (process.platform === "darwin") app.show()
    app.focus({ steal: true })
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }

  private activationTarget(): BrowserWindow | null {
    const candidates = [
      this.lastFocusedWindow,
      ...this.frameWindows.values(),
      this.window,
      ...BrowserWindow.getAllWindows(),
    ]
    for (const win of candidates) {
      if (win && !win.isDestroyed()) return win
    }
    return null
  }

  private trackFocus(win: BrowserWindow): void {
    this.lastFocusedWindow ??= win
    win.on("focus", () => {
      this.lastFocusedWindow = win
    })
    win.on("closed", () => {
      if (this.lastFocusedWindow === win) this.lastFocusedWindow = null
    })
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
    this.pushDisplay(appName(model.hostLabel))
  }

  sendTerminalData(payload: TerminalData): void {
    if (!this.window?.webContents || !this.rendererReady) return
    this.window.webContents.send("jemacs:terminal-data", payload)
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
    ipcMain.on("jemacs:input", (event, payload: NormalizedInput) => {
      // Route input through the frame that owns the window it came from, so
      // typing in a background frame focuses it instead of editing the
      // foreground one.
      const frameId = this.frameIdForWebContents(event.sender)
      for (const handler of this.inputHandlers) void handler(payload, frameId)
    })
    ipcMain.handle("jemacs:read-clipboard", () => clipboard.readText())
    ipcMain.on("jemacs:hide-application", () => app.hide())
    ipcMain.on("jemacs:ready", event => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win) win.setTitle(appName())
      this.rendererReady = true
      this.pushDisplay(appName(this.lastDisplay?.hostLabel))
      for (const handler of this.onRendererReadyHandlers) handler()
    })
  }

  /** Which editor frame does this renderer belong to? */
  private frameIdForWebContents(sender: Electron.WebContents): string | undefined {
    const win = BrowserWindow.fromWebContents(sender)
    if (!win) return undefined
    for (const [frameId, candidate] of this.frameWindows) {
      if (candidate === win) return frameId
    }
    return undefined
  }

  /**
   * Reconcile OS windows with the editor's frame list: open a window for each
   * new frame, close windows whose frame is gone, and paint each with its own
   * display model. The kernel owns frame lifetime; the host only mirrors it.
   */
  syncFrames(frames: ReadonlyArray<{ id: string; name: string }>, render: (frameId: string) => DisplayModel): void {
    for (const [frameId, win] of [...this.frameWindows]) {
      if (frames.some(frame => frame.id === frameId)) continue
      this.frameWindows.delete(frameId)
      if (!win.isDestroyed()) win.close()
    }

    for (const frame of frames) {
      let win = this.frameWindows.get(frame.id)
      if (!win || win.isDestroyed()) {
        // The first frame reuses the window opened by `start()`.
        win = this.frameWindows.size === 0 && this.window ? this.window : this.openFrameWindow(frame.id)
        this.frameWindows.set(frame.id, win)
      }
      if (!win.webContents || win.webContents.isLoading()) continue
      win.webContents.send("jemacs:display", serializeDisplayModel(render(frame.id)))
    }
  }

  private openFrameWindow(frameId: string): BrowserWindow {
    const electronDir = electronDistDir()
    const win = new BrowserWindow({
      width: 960,
      height: 720,
      title: appName(),
      webPreferences: {
        preload: path.join(electronDir, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    void win.loadFile(path.join(electronDir, "renderer.html"))
    this.trackFocus(win)
    win.on("resize", () => {
      for (const handler of this.resizeHandlers) handler(this.getViewport())
    })
    // Closing the OS window deletes the frame, matching Emacs's C-x 5 0.
    win.on("closed", () => {
      this.frameWindows.delete(frameId)
      for (const handler of this.frameClosedHandlers) handler(frameId)
    })
    return win
  }

  onFrameClosed(handler: (frameId: string) => void): void {
    this.frameClosedHandlers.push(handler)
  }

  /**
   * Evaluate an expression in the primary renderer and return its result.
   *
   * Used by the GUI smoke test to assert against the DOM Chromium actually built,
   * rather than against a model the main process merely sent. Nothing in the editor
   * calls this; it exists so the renderer half of the pipeline is verifiable.
   */
  async queryRenderer<T>(expression: string): Promise<T | undefined> {
    const win = this.frameWindows.values().next().value ?? this.window
    if (!win || win.isDestroyed()) return undefined
    return await win.webContents.executeJavaScript(expression) as T
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
