// Marker + sweep for layer-3 spawns. See "Process hygiene" in ../../AGENTS.md.
//
// tui-drive.sh spawns the editor inside a tmux pane, so it is a grandchild of the
// tmux server, not of this runner: killing the runner leaves bun reparented to
// launchd forever. Every spawn is therefore tagged with a command-line marker
// (`--jemacs-test-marker=<marker>:<run-id>`) that the sweeps below match exactly,
// so a real interactive editor is never touched.
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

export const REAP = resolve(import.meta.dir, "../../scripts/reap-strays.sh")

/** Unique per test-runner process; the `<pid>-` prefix lets `reap-strays.sh stale`
 *  tell a live run from an abandoned one. Inherited by child runners via env. */
export const TEST_RUN_ID = process.env.JEMACS_TEST_RUN_ID
  ?? `${process.pid}-${Math.random().toString(36).slice(2, 8)}`

/** Env for a marked spawn. JEMACS_TEST_RUN_ID reaches tui-drive.sh, which turns it
 *  into the command-line marker (macOS `ps -E` cannot show env, so env alone is
 *  not greppable). */
export function markerEnv(session: string): NodeJS.ProcessEnv {
  return { ...process.env, JEMACS_TMUX_SESSION: session, JEMACS_TEST_RUN_ID: TEST_RUN_ID }
}

function reap(...args: string[]): void {
  spawnSync(REAP, args, { encoding: "utf8", timeout: 15_000 })
}

/** Kill every editor still carrying this run's marker. Safe to call repeatedly. */
export function sweepThisRun(): void { reap("kill", TEST_RUN_ID) }

/** Kill marked editors left by runs whose runner pid is gone (previous crashed
 *  or interrupted suites). Never touches a concurrently running suite. */
export function sweepStaleRuns(): void { reap("stale") }
