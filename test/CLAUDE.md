# test/

| dir | what |
|---|---|
| `harness/` | `script()` fluent DSL, `keySeq()`, `fakeLspServer()`, `displayRows()`, `tuiProbe()` |
| `bugs/` | one `test.failing()` per known bug; flip to `test()` when fixed |
| `plugins/` | one file per plugin |
| (root `*.test.ts`) | kernel/display/lsp originals |

Three layers (`.claude/skills/qa/`): kernel via `script()/handleKey`; DisplayModel via `displayRows()/spans()`; real terminal via `tuiProbe()` (slow — sparingly).

`bun test` for the suite; `bun test test/bugs/NN-*` for one repro.

## Layer-3 orphaned editors (fixed)

`tuiProbe()` spawns `bun run src/main.ts` inside a tmux pane. If the runner is
interrupted (Ctrl-C, timeout, crash) the `finally { stop }` never fires, and bun
survives `tmux kill-session` → reparented to `launchd`, ~18 MB each, forever.
One machine hit 414 strays / 7.3 GB. See "Process hygiene" in `../AGENTS.md`.

Every spawn is now tagged `--jemacs-test-marker=<marker>:<run-id>`, and
`preload.ts` (via `bunfig.toml`) reaps stale runs at startup plus this run's on
exit — so an interrupted suite self-heals on the next `bun test`. Only marked
spawns are ever killed, so an interactive editor is safe.

```bash
../scripts/reap-strays.sh list    # marked spawns: pid, run-id, age
../scripts/reap-strays.sh stale   # reap runs whose runner pid is gone
ps -eo pid,ppid,rss,etime,command | awk '$2==1 && /src\/main\.ts/'   # expect none
```
