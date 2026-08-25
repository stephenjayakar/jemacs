// bun test preload: defensive process hygiene for layer-3 TUI probes.
// Wired up by bunfig.toml. See "Process hygiene" in ../AGENTS.md.
//
// tuiProbe()'s `finally { stop }` never runs if the runner itself dies (Ctrl-C,
// bun test timeout, OOM, crash), and the spawned editor is a grandchild of the
// tmux server, so nothing else reaps it. These hooks are the backstop.
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sweepStaleRuns, sweepThisRun } from "./harness/tui-reap"

// Custom-save writes `custom-file`; point it at a temp file so a test run can
// never overwrite the developer's real ~/.jemacs/custom.ts.
process.env.JEMACS_CUSTOM_FILE ??= join(tmpdir(), `jemacs-test-custom-${process.pid}.ts`)

// Strays from previous interrupted runs, reaped before we add any of our own.
sweepStaleRuns()

let swept = false
function sweep(): void {
  if (swept) return
  swept = true
  sweepThisRun()
}

// `exit` covers the normal end of the suite and most crashes; the signal hooks
// cover Ctrl-C and `kill` of the runner, which otherwise skip `exit` entirely.
process.on("exit", sweep)
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => { sweep(); process.exit(130) })
}
