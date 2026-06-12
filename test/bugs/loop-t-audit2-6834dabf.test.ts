/**
 * t-audit2-6834dabf: thin client (`client-bridge.ts`) never reconnects after
 * the WebSocket closes, and `sendInput` keeps moving the optimistic caret even
 * though the keystroke is silently dropped — so the caret walks away from the
 * server's last known position with no correction ever arriving.
 *
 * t-audit2-5a2dfacd (merged): `predict()` measured row length from
 * `.body-row` DOM `textContent` and stepped `colOffset` by ±1 code unit. A
 * soft-wrapped row renders as one `.body-row` but several visual lines, and an
 * astral codepoint (surrogate pair) is two code units, so the prediction lands
 * mid-surrogate / mid-wrap. Fix: predict from the model's logical lines and
 * step by codepoint.
 */

import { afterAll, beforeAll, expect, test } from "bun:test"

// ── Browser stubs ───────────────────────────────────────────────────────────
// Just enough `window`/`document`/`WebSocket` for client-bridge to evaluate.
// `getElementById` returns null so the dynamic `import("../electron/renderer")`
// is skipped (it gates on the renderer shell being present).

type Listener = (ev?: unknown) => void

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: FakeWebSocket[] = []
  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []
  onopen: Listener | null = null
  onmessage: Listener | null = null
  onclose: Listener | null = null
  onerror: Listener | null = null
  constructor(public readonly url: string) { FakeWebSocket.instances.push(this) }
  send(data: string): void { this.sent.push(data) }
  close(): void { this.readyState = FakeWebSocket.CLOSED; this.onclose?.({}) }
  /** Test driver: flip to OPEN and fire onopen. */
  _open(): void { this.readyState = FakeWebSocket.OPEN; this.onopen?.({}) }
}

let caretRenders = 0
const fakeRow = {
  textContent: "hello",
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 18 }),
}
const fakeBody = {
  querySelectorAll: (sel: string) => (sel.includes("body-row") ? [fakeRow] : []) as unknown[],
  appendChild: () => { caretRenders++ },
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  scrollLeft: 0, scrollTop: 0,
}
const fakeDoc = {
  title: "Jemacs",
  getElementById: () => null,
  addEventListener: () => {},
  querySelector: (sel: string) => (sel.includes("window-body") ? fakeBody : null),
  createElement: () => ({
    className: "", style: {}, appendChild: () => {}, replaceChildren: () => {},
    scrollIntoView: () => {},
  }),
  createRange: undefined, // renderCaret tolerates absence
  createTreeWalker: () => ({ nextNode: () => null }),
}

const saved: Record<string, unknown> = {}
const timeouts: Array<() => void> = []
let bridge: typeof import("../../src/web/client-bridge")

beforeAll(async () => {
  for (const k of ["window", "document", "location", "WebSocket", "setTimeout", "requestAnimationFrame"]) {
    saved[k] = (globalThis as Record<string, unknown>)[k]
  }
  const win = { __JEMACS_TOKEN__: "tok", document: fakeDoc, location: { host: "test:0" } } as Record<string, unknown>
  Object.assign(globalThis, {
    window: win,
    document: fakeDoc,
    location: win.location,
    WebSocket: FakeWebSocket,
    requestAnimationFrame: undefined,
    setTimeout: (fn: () => void) => { timeouts.push(fn); return 0 },
  })
  // self-reference so `window.jemacs = ...` works whether code uses `window` or `globalThis`
  ;(globalThis as Record<string, unknown>).window = Object.assign(win, { jemacs: undefined })
  // Cache-busted specifier: bun shares one module cache across test files, so a
  // plain import here can return a module whose top-level `connect()` already
  // ran against *another* file's WebSocket stub (loop-t-flake-18140eac).
  bridge = (await import("../../src/web/client-bridge?t=6834dabf")) as typeof import("../../src/web/client-bridge")
})

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) (globalThis as Record<string, unknown>)[k] = v
})

function model(bodyText: string, cursor: { row: number; colOffset: number }) {
  return {
    title: { chunks: [] }, minibuffer: { chunks: [] }, echo: { chunks: [] },
    minibufferCompletions: { chunks: [] }, minibufferCompletionLines: 0,
    childFrames: [], theme: { faces: { default: { fg: "#fff" } } },
    viewport: { rows: 24, cols: 80 }, hostLabel: "test",
    windows: { kind: "leaf", pane: {
      id: "w1", bufferId: "b1", selected: true, dedicated: false,
      body: { chunks: [{ text: bodyText }] }, cursor,
      modeline: { chunks: [] }, clickState: { startLine: 0, gutterPrefixLen: 0 },
      bodyLineBudget: 24, syncText: "", syncPoint: 0, textScale: 1,
    } },
  }
}

const motionKey = (name: string, ctrl = false) => ({ type: "key", key: { name, ctrl } })

// ── Reconnect + dropped-input gating ────────────────────────────────────────

test("close → schedules reconnect; sendInput while down drops without predicting", () => {
  const jemacs = (globalThis as { window: { jemacs: import("../../src/web/client-bridge").JemacsBridge } }).window.jemacs
  const ws0 = FakeWebSocket.instances[0]!
  ws0._open()
  expect(ws0.sent[0]).toContain('"auth"')

  // Seed authoritative state so prediction *could* fire.
  ws0.onmessage?.({ data: JSON.stringify(model("hello", { row: 0, colOffset: 0 })) })
  jemacs.onDisplay(() => {})
  ws0.onmessage?.({ data: JSON.stringify(model("hello", { row: 0, colOffset: 0 })) })

  // Live socket: motion key both sends and predicts.
  caretRenders = 0
  jemacs.sendInput(motionKey("right"))
  expect(ws0.sent.length).toBe(2) // auth + key
  expect(caretRenders).toBe(1)

  // Socket dies.
  ws0.close()
  expect(fakeDoc.title).toContain("disconnected")

  // Bug: prediction still fired here even though the key never reached the
  // server, so the caret kept walking with nothing to correct it.
  caretRenders = 0
  const sentBefore = ws0.sent.length
  jemacs.sendInput(motionKey("right"))
  expect(ws0.sent.length).toBe(sentBefore) // dropped — fine
  expect(caretRenders).toBe(0)             // ← must not predict for a dropped key

  // Bug: no reconnect was ever scheduled. Fix: onclose schedules connect()
  // via setTimeout (captured above), and running it constructs a fresh socket.
  expect(timeouts.length).toBeGreaterThan(0)
  timeouts.shift()!()
  expect(FakeWebSocket.instances.length).toBe(2)
  const ws1 = FakeWebSocket.instances[1]!
  ws1._open()
  expect(ws1.sent[0]).toContain('"auth"') // re-auths on the new socket
})

// ── predict() vs surrogate pairs / DOM rows ────────────────────────────────

test("predictCursor steps by codepoint and reads lengths from model lines", () => {
  // "a😀b" is 4 UTF-16 code units; colOffset is in code units (renderCaret's
  // rangeAtCharOffset walks text-node .data.length). forward-char on the server
  // moves one *codepoint*, so right from col 1 must land at col 3, not 2.
  const lines = ["a😀b", "xy"]
  expect(bridge.predictCursor({ row: 0, colOffset: 1 }, "right", lines)).toEqual({ row: 0, colOffset: 3 })
  expect(bridge.predictCursor({ row: 0, colOffset: 3 }, "left", lines)).toEqual({ row: 0, colOffset: 1 })
  // end-of-line uses the model line's code-unit length, not DOM textContent.
  expect(bridge.predictCursor({ row: 0, colOffset: 0 }, "end", lines)).toEqual({ row: 0, colOffset: 4 })
  // up/down clamp colOffset to the *model* line length, not the DOM row count.
  expect(bridge.predictCursor({ row: 0, colOffset: 4 }, "down", lines)).toEqual({ row: 1, colOffset: 2 })
  // wrap across newline still works
  expect(bridge.predictCursor({ row: 0, colOffset: 4 }, "right", lines)).toEqual({ row: 1, colOffset: 0 })
  expect(bridge.predictCursor({ row: 1, colOffset: 0 }, "left", lines)).toEqual({ row: 0, colOffset: 4 })
})
