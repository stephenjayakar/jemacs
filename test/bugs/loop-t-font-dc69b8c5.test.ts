import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { createWebHost, type WebHost } from "../../src/web/host"

// t-font-dc69b8c5 — browser caches stale /renderer.css across pulls.
// The page links `<… href="/renderer.css">` with no version param and the
// route serves it without a Cache-Control header, so a tab opened against an
// older checkout keeps the old caret/layout rules after the source CSS
// changes. Fix: serve the route `Cache-Control: no-cache` AND stamp the
// `<link>` href with `?v=<sha256-of-file>` so a fresh page load hits a new
// cache key whenever the stylesheet content changes.

let host: WebHost | undefined

afterEach(() => {
  host?.destroy()
  host = undefined
})

const cssPath = join(import.meta.dirname, "..", "..", "src", "electron", "renderer.css")

async function get(h: WebHost, path: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${h.port}${path}`, { headers: { Host: `127.0.0.1:${h.port}` } })
}

test("/renderer.css is served no-cache and the <link> href is content-versioned", async () => {
  host = await createWebHost({ port: 0, authTimeoutMs: 200 })

  // Route: must opt out of heuristic caching.
  const css = await get(host, "/renderer.css")
  expect(css.status).toBe(200)
  expect(css.headers.get("cache-control")).toBe("no-cache")

  // Page: <link> href carries ?v=<hash> tied to the file's bytes, so a new
  // pull yields a new URL. Check both modes — non-shadow rewrites the dist
  // renderer.html, shadow builds the page inline.
  const want = createHash("sha256").update(await readFile(cssPath)).digest("hex").slice(0, 16)
  const html = await (await get(host, "/")).text()
  expect(html).toContain(`href="/renderer.css?v=${want}"`)

  host.destroy()
  host = await createWebHost({ port: 0, authTimeoutMs: 200, shadow: true })
  const shadowHtml = await (await get(host, "/")).text()
  expect(shadowHtml).toContain(`href="/renderer.css?v=${want}"`)
})
