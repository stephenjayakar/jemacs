# AGENTS.md

## Workflow

- Prefer small, focused changes that match the existing TypeScript style.
- Run `bun run check` and `bun test` after code changes when possible.
- If `bun` is not on `PATH`, run those commands through `npx bun`, e.g. `npx bun run check` and `npx bun test`.
- After implementing a feature, fix, or Emacs port, commit the change before handing work back to the user (unless they asked you not to commit).

## Self-modification

- Extension surface is tracked in `src/runtime/definitions.ts` (catalog) with source locations from `captureCallerSource`.
- Live eval: `eval-defun`, `load-file`, `reload-current-file`; revert via `revert-definition` / `revert-all-definitions`.
- Eval context: `src/runtime/jemacs-runtime.ts`. Do not bypass `editor.command`, `defcustom`, `registerKeyBinding`, etc., if the goal is user-visible source links.

## Emacs fidelity

When porting or replicating a GNU Emacs interactive function:

- **Name:** Register the command under the same GNU name (kebab-case, e.g. `beginning-of-buffer`). Do not invent Jemacs-specific command names unless Emacs has no equivalent.
- **Behavior:** Match Emacs semantics for that command; check `lisp/` or the manual when unsure.
- **Key:** Wire default Emacs keybindings in `src/config/default-bindings.ts` (or user `~/.jemacs/init.ts`) via `editor.key` / `editor.defineKey` — never hardcode in `handleKey()`. Commands live in `src/core/`. See `DEFAULT_KEYBINDINGS.md`.
- **TypeScript identifiers:** Hyphenated Emacs names map to camelCase in code (`beginning-of-buffer` → helpers like `beginningOfBuffer`); the public command string stays kebab-case.

## UI hosts

- Kernel and redisplay: `src/kernel/`, `src/display/build-display-model.ts` — no `@opentui/*` or Electron imports.
- Terminal: `OpenTuiHost` in `src/ui/opentui-host.ts`; GUI: `ElectronHost` in `src/ui/electron-host.ts`.
- Bootstrap: `runJemacs()` / `bindJemacsHost()` in `src/run.ts`.
- Optional native editor pane: `JEMACS_USE_TEXTAREA=1` (selected window; font-lock via `syncSpans` + `opentui-textarea-sync.ts`).
- Shared GUI DOM: `src/display/dom-frame.ts` (used by `src/electron/renderer.ts`).
- Workspace packages: `packages/jemacs-core`, `host-opentui`, `host-electron` (re-exports; app still runs from repo root).

## Verification

### Jemacs TUI (tmux)

When verifying non-Electron features, exercise the real OpenTUI host in tmux — unit tests build `KeyEventLike` by hand and miss terminal key-encoding bugs.

```bash
export JEMACS_TMUX_SESSION=jt
scripts/tui-drive.sh start [file]          # sets JEMACS_INIT_PATH to test/fixtures/empty-config.ts
scripts/tui-drive.sh keys Tab Enter
scripts/tui-drive.sh cap                   # eyeball screen
scripts/tui-drive.sh stop
```

`tui-drive.sh` uses `scripts/bun-cmd.sh` (`bun` or `npx bun`). Startup waits up to 12s for the first frame.

#### Process hygiene (fixed — keep it that way)

Layer-3 TUI probes used to leak `bun run src/main.ts` processes. On 2026-08-03 a
machine accumulated **414 orphaned jemacs processes consuming ~7.3 GB RSS**, driving
swap to 21 GB. All were `bun run src/main.ts --config test/fixtures/stephen-config.ts`
with `ppid=1`, some 19+ hours old.

Why it happened:

- `tui-drive.sh start` runs `exec $BUN run src/main.ts $*` inside a tmux pane. The bun
  process is a **grandchild of the tmux server**, not of the test runner.
- `tuiProbe()` only stops the session in a `finally`. If the test runner dies first
  (Ctrl-C, `bun test` timeout, OOM, crash) that `finally` never runs.
- Even on `tmux kill-session`, bun does not reliably die on `SIGHUP`, so it gets
  reparented to `launchd` (`ppid=1`) and lives forever — nothing ever reaps it.
- Each orphan holds ~18 MB, so a few interrupted suite runs cost gigabytes.

How it is prevented now (four independent layers — keep all of them):

1. **Marker.** `tui-drive.sh start` tags each spawn on the *command line* with
   `--jemacs-test-marker=$JEMACS_TEST_MARKER:$JEMACS_TEST_RUN_ID` (macOS `ps -E`
   cannot show the environment, so an env-only marker would not be greppable).
   `parseStartupArgs()` ignores unknown `--flags`, so it is inert to jemacs. A real
   interactive editor carries no marker and is therefore never a sweep target.
2. **Escalation.** `tui-drive.sh stop` snapshots the pane pids *before*
   `kill-session` (afterwards they are reparented and unwalkable), then hands the
   tree to `reap-strays.sh kill-pids`: `TERM`, brief grace, `KILL`. The OpenTUI host
   ignores both `SIGHUP` and `SIGTERM` in raw mode, so `KILL` is load-bearing.
3. **Global sweep.** `test/preload.ts` (wired via `bunfig.toml`) reaps *stale* runs at
   startup and this run's spawns on `exit`/`SIGINT`/`SIGTERM`/`SIGHUP` — the backstop
   for when `finally` never runs. A run-id is `<runner-pid>-<rand>`, so `stale` only
   reaps runs whose runner pid is gone: a concurrent suite is left alone.
4. **One session per runner.** `tuiProbe()` reuses `jt<pid>`; `start` kills and
   respawns the pane per probe, so isolation is unchanged but a leak cannot multiply.

Rules when touching the TUI harness or writing layer-3 tests:

- Never rely on `finally` alone for cleanup, and never match on `src/main.ts` to kill
  things — that would also kill a real interactive editor. Match the marker.
- Escalate `TERM` → `KILL`; do not assume `SIGHUP`/`kill-session` is enough for bun.

Check for strays before and after running the suite:

```bash
scripts/reap-strays.sh list        # marked test spawns: pid, run-id, age
scripts/reap-strays.sh stale       # reap runs whose runner is gone
scripts/reap-strays.sh kill        # reap every marked spawn
bun run test:strays                # same as `list`

# raw check for orphaned editors (ppid=1); expected to print nothing
ps -eo pid,ppid,rss,etime,command | awk '$2==1 && /src\/main\.ts/'
```

### Emacs parity (tmux)

When porting GNU/Stephen Emacs behavior (major modes, hooks, keymaps), compare against **Stephen's Emacs** in tmux — not batch `emacs --batch` (markdown-mode hooks such as inline images fail there).

```bash
export JEMACS_PARITY_EMACS=1
scripts/emacs-drive.sh start examples/docs/guide.md
scripts/emacs-drive.sh keys Tab
scripts/emacs-drive.sh cap
scripts/emacs-drive.sh stop

# Automated parity suite (jemacs + emacs, same keys, compare buffer/echo):
npx bun test test/tui/markdown-parity.test.ts
```

Set `JEMACS_SKIP_TUI=1` or run in CI to skip layer-3 tests. Set `JEMACS_PARITY_EMACS=1` locally to enable Emacs-side parity checks.

Parity harness: `test/harness/tui.ts`, `test/harness/emacs.ts`, `test/harness/parity.ts`, `test/harness/screen.ts`.
