import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

const DRIVE = resolve(import.meta.dir, "../../scripts/tui-drive.sh")
let counter = 0

function sh(args: string[], session: string): string {
  const r = spawnSync(DRIVE, args, { env: { ...process.env, JEMACS_TMUX_SESSION: session }, encoding: "utf8" })
  if (r.status !== 0 && args[0] !== "stop") {
    throw new Error(`tui-drive ${args.join(" ")} failed (${r.status}): ${r.stderr || r.stdout}`)
  }
  return r.stdout
}

/** Layer-3 probe: start jemacs in tmux, send keys, capture screen, stop.
 *  Returns the plain-text screen and modeline. Slow (~500ms) — use sparingly. */
export async function tuiProbe(opts: {
  file?: string
  keys: string[]
  waitFor?: string
}): Promise<{ screen: string; modeline: string; echo: string }> {
  const session = `jt${process.pid}-${counter++}`
  try {
    sh(["start", "--config", resolve(import.meta.dir, "../fixtures/stephen-config.ts"), ...(opts.file ? [opts.file] : [])], session)
    if (opts.keys.length) sh(["keys", ...opts.keys], session)
    if (opts.waitFor) sh(["wait", opts.waitFor, "5"], session)
    const screen = sh(["cap"], session)
    const lines = screen.split("\n").filter(l => l.trim().length > 0)
    return {
      screen,
      modeline: lines[lines.length - 2] ?? "",
      echo: lines[lines.length - 1] ?? "",
    }
  } finally {
    sh(["stop"], session)
  }
}
