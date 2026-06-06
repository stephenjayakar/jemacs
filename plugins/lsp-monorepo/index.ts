import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { registerClient, type LspClient, type NotificationHandler } from "../../src/lsp/client"
import { serverBinaryAvailable } from "../../src/lsp/server-path"
import { stdioConnection } from "../../src/lsp/stdio"
import { spawnProcess, whichExecutable, type SpawnHandle, type SpawnOptions } from "../../src/platform/runtime"

export type RustAnalyzerInitOptions = {
  check: { workspace: boolean; extraArgs: string[] }
  cargo: { allTargets: boolean }
  cachePriming: { numThreads: number }
  numThreads: number
  files: { watcher: "client" | "server" }
}

/** Monorepo-tuned rust-analyzer settings: check the current crate only and cap parallelism. */
export function rustAnalyzerInitOptions(): RustAnalyzerInitOptions {
  return {
    check: { workspace: false, extraArgs: ["--jobs", "8"] },
    cargo: { allTargets: false },
    cachePriming: { numThreads: 8 },
    numThreads: 8,
    files: { watcher: "client" },
  }
}

export const RA_MULTIPLEX_CLIENT_CMD = ["ra-multiplex", "client", "--server-path", "rust-analyzer"] as const

export const RA_MULTIPLEX_SERVER_CMD =
  "nohup nice -n10 ra-multiplex server >/tmp/ra-multiplex.log 2>&1 &"

/** RA emits hundreds of $/progress notifications per second while indexing; swallow them. */
const dropProgress: NotificationHandler = () => {}

export function makeRaMultiplexClient(): LspClient {
  return {
    serverId: "ra-multiplex",
    majorModes: ["rust"],
    priority: 20,
    languageId: () => "rust",
    initializationOptions: rustAnalyzerInitOptions,
    notificationHandlers: new Map([["$/progress", dropProgress]]),
    newConnection: stdioConnection([...RA_MULTIPLEX_CLIENT_CMD], () => serverBinaryAvailable("ra-multiplex")),
  }
}

type Spawn = (opts: SpawnOptions) => SpawnHandle

export async function raMultiplexRunning(spawn: Spawn): Promise<boolean> {
  try {
    const proc = spawn({ cmd: ["ra-multiplex", "status"], stdout: "ignore", stderr: "ignore" })
    return (await proc.exited) === 0
  } catch {
    return false
  }
}

export function startRaMultiplexServer(spawn: Spawn): void {
  spawn({ cmd: ["sh", "-c", RA_MULTIPLEX_SERVER_CMD] })
}

/** Bring up the shared ra-multiplex daemon (niced) so RA's full reindex happens once per workspace. */
export async function ensureRaMultiplexServer(
  deps: { spawn?: Spawn; which?: (name: string) => string | null } = {},
): Promise<"running" | "started" | "unavailable"> {
  const spawn = deps.spawn ?? spawnProcess
  const which = deps.which ?? whichExecutable
  if (!which("ra-multiplex")) return "unavailable"
  if (await raMultiplexRunning(spawn)) return "running"
  startRaMultiplexServer(spawn)
  return "started"
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  registerClient(makeRaMultiplexClient())
  void ensureRaMultiplexServer()
    .then(state => {
      if (state === "started") editor.message("ra-multiplex server started (nice -n10)")
      else if (state === "unavailable") editor.message("ra-multiplex not on PATH; falling back to rust-analyzer")
    })
    .catch(err => editor.message(`ra-multiplex: ${(err as Error).message}`))
}
