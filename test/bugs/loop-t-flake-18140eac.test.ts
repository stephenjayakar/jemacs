/**
 * t-flake-18140eac: loop-t-audit2-6834dabf "close → schedules reconnect" was
 * order-dependent (~5% in full suite). It relied on `await import(client-bridge)`
 * re-running the module-level `connect()` against its own `FakeWebSocket`, but
 * bun shares one module cache across every test file in the process. When
 * loop-t-audit2-5a2dfacd (the other client-bridge importer) happened to run
 * first, `connect()` had already fired against *that* file's stub, so
 * 6834dabf's `FakeWebSocket.instances[0]` was undefined and the test threw on
 * `ws0._open()`.
 *
 * Fix (in 6834dabf): import via a cache-busted specifier so the module body —
 * and therefore `connect()` and `window.jemacs = …` — re-evaluates against the
 * globals *this* file installed, regardless of who imported it earlier.
 *
 * This file pins that contract deterministically: seed the cache with stub A,
 * then re-stub with B and import the cache-busted path. The second import must
 * construct a B and assign `window.jemacs`.
 */

import { afterAll, expect, test } from "bun:test"

const noop = () => {}
const doc = { getElementById: () => null, addEventListener: noop, querySelector: () => null, title: "" }
const saved: Record<string, unknown> = {}
for (const k of ["window", "document", "location", "WebSocket", "requestAnimationFrame"]) {
  saved[k] = (globalThis as Record<string, unknown>)[k]
}
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) (globalThis as Record<string, unknown>)[k] = v
})

class StubA { onopen: unknown; onmessage: unknown; onclose: unknown; onerror: unknown
  readyState = 0; send = noop; close = noop }
class StubB { static instances: StubB[] = []
  onopen: unknown; onmessage: unknown; onclose: unknown; onerror: unknown
  readyState = 0; send = noop; close = noop
  constructor(public url: string) { StubB.instances.push(this) } }

function install(WS: unknown) {
  const win = { __JEMACS_TOKEN__: "t", document: doc, location: { host: "h:0" }, jemacs: undefined }
  Object.assign(globalThis, {
    window: win, document: doc, location: win.location, WebSocket: WS, requestAnimationFrame: undefined,
  })
  return win as { jemacs?: unknown }
}

test("cache-busted client-bridge import re-runs connect() against current globals", async () => {
  // Seed the plain-specifier cache the way another test file would.
  install(StubA)
  await import("../../src/web/client-bridge")

  // Re-stub and import via the cache-busted path 6834dabf uses.
  const win = install(StubB)
  type Bridge = typeof import("../../src/web/client-bridge")
  const fresh = (await import("../../src/web/client-bridge?t=flake-18140eac")) as Bridge

  // Without the cache-buster these are 0 / undefined — the original flake.
  expect(StubB.instances.length).toBe(1)
  expect(win.jemacs).toBeDefined()
  expect(typeof fresh.predictCursor).toBe("function")
})
