import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("jemacs", {
  onDisplay(handler: (model: unknown) => void): () => void {
    const listener = (_event: unknown, model: unknown) => handler(model)
    ipcRenderer.on("jemacs:display", listener)
    return () => ipcRenderer.removeListener("jemacs:display", listener)
  },
  onTerminalData(handler: (payload: unknown) => void): () => void {
    const listener = (_event: unknown, payload: unknown) => handler(payload)
    ipcRenderer.on("jemacs:terminal-data", listener)
    return () => ipcRenderer.removeListener("jemacs:terminal-data", listener)
  },
  sendInput(payload: unknown): void {
    ipcRenderer.send("jemacs:input", payload)
  },
  sendFontMetrics(batch: unknown, reset: boolean): void {
    ipcRenderer.send("jemacs:font-metrics", batch, reset)
  },
  readClipboardText(): Promise<string> {
    return ipcRenderer.invoke("jemacs:read-clipboard")
  },
  /** The clipboard image as base64 PNG, or "" when there is none. */
  readClipboardImage(): Promise<string> {
    return ipcRenderer.invoke("jemacs:read-clipboard-image")
  },
  hideApplication(): void {
    ipcRenderer.send("jemacs:hide-application")
  },
  ready(): void {
    ipcRenderer.send("jemacs:ready")
  },
})
