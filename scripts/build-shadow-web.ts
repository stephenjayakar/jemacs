/**
 * Build the browser shadow bundle: a full `Editor` + `attachShadow` that runs
 * in a page and talks to an authority over a WebSocket.
 *
 *   bun run scripts/build-shadow-web.ts  →  dist/shadow-web/editor.js
 *
 * The kernel + config tree imports `node:*` liberally. Bun's `target:"browser"`
 * polyfills the pure-JS ones (`path`, `os`, `url`, `crypto`, `buffer`,
 * `stream`, `util`, `events`). The ones with no browser equivalent are
 * redirected to `src/web/node-stubs.ts` so they're present at link time but
 * throw on call — see shadow/DESIGN.md §Filesystem replica.
 */

import type { BunPlugin } from "bun"
import { mkdir, readdir } from "node:fs/promises"
import { join } from "node:path"

const root = join(import.meta.dirname, "..")
const outdir = join(root, "dist/shadow-web")
const stubPath = join(root, "src/web/node-stubs.ts")
const cryptoShimPath = join(root, "src/web/crypto-shim.ts")
const fontsDir = join(root, "src/web/fonts")
const fetchFontsScript = join(root, "scripts/fetch-fonts.sh")

/** Specifiers that have no meaningful browser polyfill. Everything else
 *  (`node:path`, `node:os`, `node:url`, `node:crypto`, `node:buffer`,
 *  `node:stream`, `node:util`, `node:events`, `node:path/posix`) is left to
 *  Bun's built-in browser polyfills. */
const STUBBED = new Set([
  "node:fs",
  "node:fs/promises",
  "node:child_process",
  "node:module",
  "node:url", // polyfill lacks fileURLToPath/pathToFileURL
  "bun:ffi",
])

const nodeStubPlugin: BunPlugin = {
  name: "shadow-node-stubs",
  setup(build) {
    build.onResolve({ filter: /^(node:|bun:ffi$)/ }, args => {
      if (STUBBED.has(args.path)) return { path: stubPath }
      // node:crypto → shim that re-exports the polyfill + adds timingSafeEqual.
      // The shim itself imports node:crypto; let that one fall through.
      if (args.path === "node:crypto" && args.importer !== cryptoShimPath) {
        return { path: cryptoShimPath }
      }
      return undefined // fall through to Bun's browser polyfill
    })
  },
}

/** Native or host-only packages the kernel reaches via lazy `require`. They're
 *  never import-time dependencies of `shadow-entry.ts`, but listing them as
 *  external guards against a future static import sneaking in. */
const EXTERNAL = [
  "tree-sitter",
  "tree-sitter-*",
  "@tree-sitter-grammars/*",
  "@opentui/*",
  "@xterm/*",
  "electron",
]

export async function buildShadowWeb(): Promise<string> {
  await mkdir(outdir, { recursive: true })
  const result = await Bun.build({
    entrypoints: [join(root, "src/web/shadow-entry.ts")],
    outdir,
    target: "browser",
    format: "esm",
    minify: false,
    sourcemap: "linked",
    naming: { entry: "editor.js" },
    plugins: [nodeStubPlugin],
    external: EXTERNAL,
    define: {
      "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV ?? "production"),
      "process.platform": JSON.stringify("browser"),
      "Bun.argv": "[]",
    },
  })
  if (!result.success) {
    throw new Error(result.logs.map(String).join("\n"))
  }
  const out = result.outputs.find(o => o.kind === "entry-point")
  return out?.path ?? join(outdir, "editor.js")
}

/** `src/web/fonts/*.woff2` is gitignored — a fresh clone has only the LICENSE
 *  files, so host.ts serves 404 for every @font-face. Run fetch-fonts.sh on
 *  demand instead of relying on the user to remember a separate step. `run` is
 *  injectable so tests can assert the trigger without network I/O. */
export async function ensureFonts(
  dir: string = fontsDir,
  run: (script: string) => Promise<number> = sh,
): Promise<"ok" | "fetched"> {
  const entries = await readdir(dir).catch(() => [] as string[])
  if (entries.some(f => f.endsWith(".woff2"))) return "ok"
  console.log(`No .woff2 in ${dir} — running fetch-fonts.sh`)
  const code = await run(fetchFontsScript)
  if (code !== 0) throw new Error(`fetch-fonts.sh exited ${code}`)
  return "fetched"
}

async function sh(script: string): Promise<number> {
  const proc = Bun.spawn(["sh", script], { stdout: "inherit", stderr: "inherit" })
  return await proc.exited
}

if (import.meta.main) {
  await ensureFonts()
  const out = await buildShadowWeb()
  console.log(`Built browser shadow bundle → ${out}`)
}
