import { afterAll, expect, test } from "bun:test"
import { createWebHost, type WebHost } from "../../src/web/host"

// t-audit2-23c07cf0: shadow `/` template lacked `#jemacs-minibuffer-completions`.
// `shadow-entry.defaultTargets()` then resolved that slot to `undefined`, so the
// DOM frame had nowhere to mount fido/vertico candidates — completion list
// silently never rendered. Lock the served HTML to the id set `defaultTargets`
// probes for (title/windows/minibuffer/echo are hard-required; completions is
// the optional one this bug dropped).
//
// Merged regressions exercised against the same live server:
//   t-audit2-3b02a351  /favicon.ico → 204 (was 404 console noise every load)
//   t-audit2-9b87128c  /ws Origin guard + case-insensitive Host compare
//
// t-audit2-df2a71a8 (present() rebuilds LogicalModel) is intentionally NOT
// fixed here: webLayout needs LogicalModel for the positioned-caret path that
// `client-bridge` reads (`pane.cursor`); serializing the incoming char-grid
// DisplayModel would regress variable-pitch caret placement (29189ed). The
// wasted-work fix lives in run-core / build-display-model, outside this file's
// ownership.

let host: WebHost | undefined
afterAll(() => host?.destroy())

test("shadow HTML serves every mount point shadow-entry probes for", async () => {
  host = await createWebHost({ port: 0, shadow: true })
  const base = `http://127.0.0.1:${host.port}`

  const html = await (await fetch(`${base}/`)).text()
  for (const id of [
    "jemacs-title",
    "jemacs-windows",
    "jemacs-minibuffer-completions",
    "jemacs-minibuffer",
    "jemacs-echo",
  ]) {
    expect(html).toContain(`id="${id}"`)
  }
  // Stylesheet is what gives `.jemacs-caret` absolute positioning.
  expect(html).toMatch(/href="\/renderer\.css(\?v=[0-9a-f]+)?"/)
})

test("/favicon.ico is a quiet 204, not a 404", async () => {
  const res = await fetch(`http://127.0.0.1:${host!.port}/favicon.ico`)
  expect(res.status).toBe(204)
})

test("/ws upgrade rejects foreign Origin (CSWSH guard)", async () => {
  const base = `http://127.0.0.1:${host!.port}`
  // Cross-site page dialing our loopback socket: must be refused pre-upgrade.
  const evil = await fetch(`${base}/ws`, { headers: { Origin: "http://evil.example" } })
  expect(evil.status).toBe(403)
  // Same-origin without an Upgrade header falls through to 426, proving the
  // Origin check passed and only the protocol negotiation is missing.
  const ok = await fetch(`${base}/ws`, { headers: { Origin: base } })
  expect(ok.status).toBe(426)
  // Non-browser clients (no Origin header) are allowed — they can't read `/`
  // to lift the token, and the bearer auth still gates the socket.
  const cli = await fetch(`${base}/ws`)
  expect(cli.status).toBe(426)
})

test("Host header compare is case-insensitive", async () => {
  const res = await fetch(`http://127.0.0.1:${host!.port}/`, {
    headers: { Host: `LOCALHOST:${host!.port}` },
  })
  expect(res.status).toBe(200)
})
