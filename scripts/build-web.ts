import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

const root = join(import.meta.dirname, "..")
const out = join(root, "dist/web")

export async function buildWebAssets(): Promise<void> {
  await mkdir(out, { recursive: true })

  const result = await Bun.build({
    entrypoints: [join(root, "src/web/client-bridge.ts")],
    outdir: out,
    target: "browser",
    format: "esm",
    minify: false,
  })
  if (!result.success) throw new Error(result.logs.map(String).join("\n"))

  // The web host serves the renderer at `/` and assets at absolute paths;
  // rewrite the relative hrefs the Electron build uses.
  const html = (await readFile(join(root, "src/electron/renderer.html"), "utf8"))
    .replace(`href="xterm.css"`, `href="/xterm.css"`)
    .replace(`href="renderer.css"`, `href="/renderer.css"`)
    .replace(`src="renderer.js"`, `src="/renderer.js"`)
  await writeFile(join(out, "renderer.html"), html)

  await cp(join(root, "src/electron/renderer.css"), join(out, "renderer.css"))
  await cp(join(root, "node_modules/@xterm/xterm/css/xterm.css"), join(out, "xterm.css"))
}

if (import.meta.main) {
  await buildWebAssets()
  console.log("Built web assets in dist/web")
}
