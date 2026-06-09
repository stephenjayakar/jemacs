// Minimal CDP driver — spawns headless Chromium, gives keyboard + eval + screenshot.
// Used by qa.test.ts so we don't need puppeteer.
import { spawn, type ChildProcess } from "node:child_process"

export type Driver = {
  eval<T = unknown>(expr: string): Promise<T>
  key(key: string, mods?: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean }): Promise<void>
  type(text: string): Promise<void>
  screenshot(path: string): Promise<void>
  close(): Promise<void>
}

const CHROMIUM = process.env.CHROMIUM_PATH
  ?? "/nix/store/68h63fg3qyv62lkvmqpkdk8g8qnldzhp-chromium-147.0.7727.137/bin/chromium"

export async function launch(url: string, opts: { debugPort?: number } = {}): Promise<Driver> {
  const port = opts.debugPort ?? (19222 + Math.floor(Math.random() * 1000))
  const child: ChildProcess = spawn(CHROMIUM, [
    "--headless", "--no-sandbox", "--disable-gpu",
    `--remote-debugging-port=${port}`, "--remote-allow-origins=*",
    "--window-size=1280,800", url,
  ], { stdio: ["ignore", "ignore", "pipe"] })

  // Wait for the devtools endpoint.
  let target: { webSocketDebuggerUrl: string } | undefined
  for (let i = 0; i < 50 && !target; i++) {
    await new Promise(r => setTimeout(r, 100))
    target = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json())
      .then((ts: Array<{type:string;url:string;webSocketDebuggerUrl:string}>) =>
        ts.find(t => t.type === "page" && !t.url.startsWith("chrome")))
      .catch(() => undefined)
  }
  if (!target) { child.kill(); throw new Error("CDP: chromium did not expose debugging port") }

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = e => rej(e) })
  let seq = 0
  const pending = new Map<number, (r: unknown) => void>()
  ws.onmessage = e => {
    const m = JSON.parse(String(e.data))
    if (m.id != null) { pending.get(m.id)?.(m.result); pending.delete(m.id) }
  }
  const send = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    new Promise(r => { const id = ++seq; pending.set(id, v => r(v as T)); ws.send(JSON.stringify({ id, method, params })) })

  await send("Runtime.enable")
  // Wait for the app's first WS model to land.
  for (let i = 0; i < 30; i++) {
    const r = await send<{result:{value:boolean}}>("Runtime.evaluate", { expression: "!!document.querySelector('.window-modeline')" })
    if (r.result.value) break
    await new Promise(r => setTimeout(r, 100))
  }

  const KEYMAP: Record<string, { code: string; key: string; vk: number; text?: string }> = {
    Enter:     { code: "Enter",      key: "Enter",      vk: 13, text: "\r" },
    Tab:       { code: "Tab",        key: "Tab",        vk: 9,  text: "\t" },
    Escape:    { code: "Escape",     key: "Escape",     vk: 27 },
    Backspace: { code: "Backspace",  key: "Backspace",  vk: 8 },
    Space:     { code: "Space",      key: " ",          vk: 32, text: " " },
    ArrowUp:   { code: "ArrowUp",    key: "ArrowUp",    vk: 38 },
    ArrowDown: { code: "ArrowDown",  key: "ArrowDown",  vk: 40 },
    ArrowLeft: { code: "ArrowLeft",  key: "ArrowLeft",  vk: 37 },
    ArrowRight:{ code: "ArrowRight", key: "ArrowRight", vk: 39 },
  }

  async function key(k: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {}) {
    const m = (mods.alt?1:0) | (mods.ctrl?2:0) | (mods.meta?4:0) | (mods.shift?8:0)
    const named = KEYMAP[k]
    const text = named?.text ?? (k.length === 1 && !mods.ctrl && !mods.meta && !mods.alt ? k : undefined)
    const base = {
      key: named?.key ?? k,
      code: named?.code ?? (k.length === 1 ? `Key${k.toUpperCase()}` : k),
      windowsVirtualKeyCode: named?.vk ?? (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0),
      modifiers: m,
    }
    await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, text })
    await send("Input.dispatchKeyEvent", { type: "keyUp", ...base })
    await new Promise(r => setTimeout(r, 30))   // let WS round-trip + render
  }

  return {
    async eval<T>(expr: string): Promise<T> {
      const r = await send<{result:{value:T}}>("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })
      return r.result.value
    },
    key,
    async type(text: string) { for (const c of text) await key(c) },
    async screenshot(path: string) {
      const r = await send<{data:string}>("Page.captureScreenshot", { format: "png" })
      await Bun.write(path, Buffer.from(r.data, "base64"))
    },
    async close() { ws.close(); child.kill() },
  }
}
