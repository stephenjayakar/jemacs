---
name: bugfix
description: End-to-end bug-fix loop for jemacs — repro as test.failing(), partition by file, fix in parallel, verify at three layers.
---

# bugfix

Given a list of bugs (from a hunt, QA sweep, or user report), turn them into fixed code with regression tests.

## Loop

1. **Repro first.** For each bug, write `test/bugs/<NN>-<slug>.test.ts` using `test.failing(...)` and the harness (`script()`, `keySeq()`, `fakeLspServer()`, `displayRows()`). The test must *pass* (because `test.failing` inverts) — if it doesn't, you haven't reproduced the bug. Keep it under 15 lines.

2. **Partition by file.** Group bugs by the src/ file they touch. One agent per file (or tightly-coupled pair) — never two agents on the same file.

3. **Fix.** Each agent: read its repro tests, make the minimal fix, flip `test.failing` → `test`, run `bun test test/bugs/<NN>-*` (must pass), then `bun test` (no regressions in its area).

4. **Integrate.** `bun test` full suite green; `bun run check` no new errors.

5. **Layer-3 verify.** For anything touching key dispatch, display, or LSP, drive it through `scripts/tui-drive.sh` on `examples/` and eyeball. The harness can't catch what the terminal encoding does.

6. **Commit.** One commit per partition is fine; or one commit for the whole batch if it's small.

## When a repro won't reproduce

If `test.failing` fails (i.e., the inner expect *passes*), one of: the bug report is wrong; the harness is masking it (e.g., `parseKey` doesn't model the terminal's exact event); or the bug only shows at layer 3. Downgrade to `test.todo(...)` with a note and add a `tuiProbe()` check instead.

## Harness gaps

If a bug needs infra the harness doesn't have, add it to `test/harness/` first (with its own test in `harness.test.ts`), commit, then write the repro. Don't inline harness logic in bug tests.
