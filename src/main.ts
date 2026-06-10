import { writeFileSync } from "node:fs"
import { closeSync, openSync, unlinkSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Editor } from "./kernel/editor"
import { installDefaultConfig, installDefaultHooks, installUserConfig, loadCustomFile } from "./config"
import { loadStartupConfig, parseStartupArgs } from "./config/startup"
import { installDefaultModes } from "./modes/default-modes"
import { installLspMode } from "./lsp/install"
import { installXref } from "./xref/install"
import { runJemacs } from "./run"
import { createDefaultHost } from "./ui/select-host"
import { installBuiltinPlugins } from "../plugins/builtin"
import { attachAuthority } from "./shadow/shadow"
import { StdioLink } from "./shadow/stdio-link"

async function main(): Promise<void> {
  const serveStdio = Bun.argv.includes("--serve-stdio")
  // In stdio-serve mode stdout is the ShadowLink wire, so any stray console.log
  // would corrupt framing. Divert to stderr before anything else loads.
  if (serveStdio) console.log = console.error

  const web = Bun.argv.includes("--web")
  const shadow = Bun.argv.includes("--shadow")
  const portIdx = Bun.argv.indexOf("--port")
  const webPort = portIdx >= 0 ? Number(Bun.argv[portIdx + 1]) : undefined

  installDefaultModes()
  const editor = new Editor()
  const ignored = new Set(["--gui", "--smoke-gui", "--serve-stdio", "--web", "--shadow", "--port"])
  if (portIdx >= 0 && Bun.argv[portIdx + 1] != null) ignored.add(Bun.argv[portIdx + 1]!)
  const args = parseStartupArgs(Bun.argv, ignored)
  const evaluator = installDefaultConfig(editor)
  for (const config of args.configs) await loadStartupConfig(editor, evaluator, config)
  installLspMode(editor)
  installDefaultHooks(editor)
  installXref(editor)
  await installBuiltinPlugins(editor)
  await installUserConfig(editor, evaluator)
  await loadCustomFile(editor, evaluator)

  const file = args.files[0]
  if (file) await editor.openFile(file)

  // Out-of-band buffer probe for the layer-3 shadow integration test and
  // scripts/shadow-pair.sh: lets a test read A's in-memory text without a UI.
  // O_EXCL + 0o600: buffer content can be sensitive; don't follow a pre-planted
  // symlink and don't leave it world-readable. Unlink first so repeat dumps work.
  process.on("SIGUSR1", () => {
    const p = join(tmpdir(), `jemacs-dump-${process.pid}`)
    try { unlinkSync(p) } catch { /* may not exist */ }
    try {
      const fd = openSync(p, "wx", 0o600)
      writeSync(fd, editor.currentBuffer.text)
      closeSync(fd)
    } catch { /* best-effort */ }
  })

  if (serveStdio) {
    const link = new StdioLink(process.stdin, process.stdout, {
      role: "authority",
      onClose: () => { editor.running = false; process.exit(0) },
    })
    attachAuthority(editor, link)
    // Announce existing buffers so S can mirror them with matching ids; without
    // this S has no bufferId to address splices to.
    for (const buf of editor.buffers.values()) {
      link.send({ kind: "buffer", id: buf.id, path: buf.path, text: buf.text, mode: buf.mode })
    }
    // No UI host: stdin's data listener keeps the event loop alive until the
    // shadow disconnects.
    return
  }

  if (web) {
    const { createWebHost } = await import("./web/host")
    const host = await createWebHost({ port: webPort, shadow })
    host.attachEditor(editor)
    console.log(`Web: http://127.0.0.1:${host.port}/`)
    await runJemacs(editor, host)
    return
  }

  await runJemacs(editor, await createDefaultHost())
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
