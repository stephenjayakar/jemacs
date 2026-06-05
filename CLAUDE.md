# jemacs — Claude context

Emacs-like editor; TypeScript is the elisp. Display-agnostic kernel (`src/kernel/`, `src/display/`) + two hosts (OpenTUI terminal, Electron). See `AGENTS.md` for repo conventions, `ROADMAP.md` for the plugin plan, `DESIGN.md` for the core/config split and hot-reload architecture.

## Testing a change before landing

Load the `qa` skill (`.claude/skills/qa/SKILL.md`) for the full three-layer protocol. Short form:

1. `bun test` — full suite (one known failure: `proto-renumber`, preexisting).
2. `bun run check` — no *new* tsc errors (a handful are preexisting in `src/lsp/` and tests; see TODO.md).
3. Layer-3 smoke through the real terminal:
   ```bash
   export JEMACS_TMUX_SESSION=jt
   scripts/tui-drive.sh start [file]
   scripts/tui-drive.sh keys C-x C-f ... Enter   # exercise the change
   scripts/tui-drive.sh cap                      # eyeball
   scripts/tui-drive.sh stop
   ```
4. Commit. AGENTS.md says commit before handing back; one logical change per commit.

If the change touches key dispatch, the minibuffer, or font-lock, also add a `buildDisplayModel(editor)` assertion (layer 2).

## Landing to upstream

We have write access to `stephenjayakar/jemacs`. Workflow for shipping a batch:

1. Push to `fork/main` (`antsujay/jemacs`) and open a PR against `stephenjayakar/jemacs:main`.
2. Run `/code-review medium` on the PR diff (or the deep-review workflow for large batches).
3. If the review is clean and `bun test` is green, merge it yourself: `gh pr merge <N> --repo stephenjayakar/jemacs --merge`. Don't enable auto-merge; merge after review.
4. Pull `origin/main` back into local `main` so the next batch is based on the merge commit.

Stephen also pushes directly — fetch `origin` before each batch and merge his work first.

## Adding behavior

New behavior goes in `plugins/<name>/index.ts` exporting `install(editor)`, plus `test/plugins/<name>.test.ts`. Register it in `plugins/builtin.ts`. Don't add commands to `src/core/` or `src/config/` — those are slated to become plugins themselves (see DESIGN.md).

src/ edits only when a plugin needs an extension point the kernel doesn't expose yet. Keep those edits minimal and note them in the commit message.

## Gotchas

- Layer-1 tests build `KeyEventLike` by hand and never exercise OpenTUI's key encoding — shifted-punctuation bindings can pass at layer 1 and fail at layer 3.
- `bun install` may hang behind a private npm registry that's missing `@opentui/*`; the packages are cache-resolvable, see PROBLEMS.md if you hit this.
