import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { extractEcho, extractModeline } from "./screen"
import { markerEnv, sweepThisRun } from "./tui-reap"

const DRIVE = resolve(import.meta.dir, "../../scripts/tui-drive.sh")

// One session per runner process, reused across probes: `start` kills and respawns
// the pane each time, so probes stay isolated, but a leak can no longer multiply
// per probe. See "Process hygiene" in ../../AGENTS.md.
const SESSION = `jt${process.pid}`

function sh(args: string[], session: string): string {
  const r = spawnSync(DRIVE, args, { env: markerEnv(session), encoding: "utf8" })
  if (r.status !== 0 && args[0] !== "stop") {
    throw new Error(`tui-drive ${args.join(" ")} failed (${r.status}): ${r.stderr || r.stdout}`)
  }
  return r.stdout
}

let teardownArmed = false
function armTeardown(): void {
  if (teardownArmed) return
  teardownArmed = true
  // Backstop for the `finally` below: if the runner exits mid-probe, the pane
  // is a grandchild of the tmux server and survives on its own.
  process.on("exit", () => { sh(["stop"], SESSION); sweepThisRun() })
}

/** Layer-3 probe: start jemacs in tmux, send keys, capture screen, stop.
 *  Returns the plain-text screen and modeline. Slow (~500ms) — use sparingly. */
export async function tuiProbe(opts: {
  file?: string
  keys: string[]
  waitFor?: string
}): Promise<{ screen: string; modeline: string; echo: string }> {
  armTeardown()
  const session = SESSION
  try {
    sh([
      "start",
      "--config", resolve(import.meta.dir, "../fixtures/stephen-config.ts"),
      ...(opts.file ? [opts.file] : []),
    ], session)
    if (opts.keys.length) sh(["keys", ...opts.keys], session)
    if (opts.waitFor) sh(["wait", opts.waitFor, "10"], session)
    const screen = sh(["cap"], session)
    return {
      screen,
      modeline: extractModeline(screen),
      echo: extractEcho(screen),
    }
  } finally {
    sh(["stop"], session)
  }
}
