import type { BunPlugin } from "bun"
import { cp, mkdir, readFile } from "node:fs/promises"
import path from "node:path"

const root = path.join(import.meta.dirname, "..")
const out = path.join(root, "dist/electron")
const ptyNode = path.join(root, "plugins/term/pty-node.ts")

/** term/pty.ts uses bun:ffi; swap in the Node PTY adapter for the Electron main bundle. */
const electronPtyNodePlugin: BunPlugin = {
  name: "electron-pty-node",
  setup(build) {
    build.onLoad({ filter: /plugins\/term\/pty\.ts$/ }, async () => ({
      contents: await readFile(ptyNode, "utf8"),
      loader: "ts",
    }))
  },
}

/** Native / path-sensitive deps must not be bundled into Electron main (font-lock breaks silently). */
const ELECTRON_MAIN_EXTERNALS = [
  "electron",
  "@opentui/core",
  "@opentui/core/testing",
  "tree-sitter",
  "tree-sitter-python",
  "tree-sitter-javascript",
  "tree-sitter-html",
  "tree-sitter-java",
  "@tree-sitter-grammars/tree-sitter-markdown",
]

await mkdir(out, { recursive: true })

// Preload must be CJS: Electron's sandboxed preload cannot run top-level `import`.
const preload = await Bun.build({
  entrypoints: [path.join(root, "src/electron/preload.ts")],
  outdir: out,
  target: "node",
  format: "cjs",
  external: ["electron"],
})
if (!preload.success) throw new Error(preload.logs.join("\n"))

const renderer = await Bun.build({
  entrypoints: [path.join(root, "src/electron/renderer.ts")],
  outdir: out,
  target: "browser",
  format: "esm",
})
if (!renderer.success) throw new Error(renderer.logs.join("\n"))

const main = await Bun.build({
  entrypoints: [path.join(root, "src/main-electron.ts")],
  outdir: path.join(root, "dist"),
  target: "node",
  format: "esm",
  external: ELECTRON_MAIN_EXTERNALS,
  plugins: [electronPtyNodePlugin],
})
if (!main.success) throw new Error(main.logs.join("\n"))

const preview = await Bun.build({
  entrypoints: [path.join(root, "src/electron/browser-preview.ts")],
  outdir: out,
  target: "browser",
  format: "esm",
})
if (!preview.success) throw new Error(preview.logs.join("\n"))

await cp(path.join(root, "src/electron/renderer.html"), path.join(out, "renderer.html"))
await cp(path.join(root, "src/electron/renderer.css"), path.join(out, "renderer.css"))
await cp(path.join(root, "node_modules/@xterm/xterm/css/xterm.css"), path.join(out, "xterm.css"))
await cp(path.join(root, "src/electron/gui-preview.html"), path.join(out, "gui-preview.html"))
await cp(path.join(root, "src/electron/bootstrap.mjs"), path.join(out, "bootstrap.mjs"))
await cp(path.join(root, "src/electron/ts-loader-hook.mjs"), path.join(out, "ts-loader-hook.mjs"))
await cp(path.join(root, "src/electron/fixtures"), path.join(out, "fixtures"), { recursive: true })

console.log("Built Electron assets in dist/electron and dist/main-electron.js")
