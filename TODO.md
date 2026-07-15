# TODO

## Emacs parity pass (2026-07-14)

- [x] Match GNU `markdown-mode` RET and repeated/nested TAB behavior; keep Stephen's trailing-whitespace cleanup.
- [x] Make Markdown `C-s [` search for a literal bracket in TUI and GUI.
- [x] Make Markdown checkbox clicks and click-to-cursor mapping agree in TUI and GUI.
- [x] Match Stephen's `undo-tree` startup, centered visualizer, and quit-to-parent behavior.
- [x] Verify `gptel` and TRAMP through the installed configuration.
- [x] Fix and live-test the Magit staged-commit workflow.
- [x] Stabilize tmux control-mode panes and preserve `other-window` navigation.

## Bugs (from deep hunt — see file:line for each)

### High — corrupts buffer / desyncs LSP
- [ ] `transpose-chars` at EOB inserts `"undefined"` — `src/core/emacs-standard.ts:18`
- [ ] LSP transport miscounts bytes on non-ASCII (Content-Length is bytes, code slices code-units) — `src/lsp/transport.ts:72`
- [ ] LSP stdio decoder drops bytes at chunk boundaries (missing `{stream:true}`) — `src/lsp/stdio.ts:31`
- [ ] LSP full-sync sends *pre-change* text; first insert into empty file sends `""` — `src/lsp/manager.ts:38` + `sync.ts:58`
- [ ] `deleteRange`/`undo`/`redo` skip `onTextChange` → kill-word/kill-line/C-/ silently desync LSP — `src/kernel/buffer.ts:99,206`
- [ ] `yank-pop` replaces text *past* the yanked region (recordYank reads point post-insert) — `src/core/commands.ts:54`
- [ ] `CommandRegistry.restoreAll()` always throws (`Map.names()`) — `src/kernel/command.ts:69`
- [ ] kbd macros never record `self-insert-command` → can't replay typing — `src/kernel/editor.ts:530`
- [ ] `normalizeToken("M--")` → `"M-"`; `-` key unbindable — `src/kernel/keymap.ts:125`

### Med — wrong behavior
- [ ] LSP spawn failure surfaces as OpenTUI's "Console (Focused)" debug overlay instead of `editor.message()` — wrap `connect()` in `src/lsp/manager.ts` and demote.
- [ ] Lower-priority exact binding shadows higher-priority prefix (`C-c` global beats `C-c C-c` mode) — `src/kernel/keymap.ts:89`
- [ ] `indent-for-tab-command` never indents (`!Promise` always false) — `src/core/commands.ts:386`
- [ ] `goto-line` past EOF leaves `point > text.length` — `src/core/commands.ts:248`
- [ ] `point-to-register` doesn't record bufferId; jump lands in wrong buffer — `src/kernel/register.ts:4`
- [ ] mark not adjusted on insert/delete before it — `src/kernel/buffer.ts:62`
- [ ] `ensureOtherWindowSelected` splits even when a free window exists — `src/kernel/window.ts:118`
- [ ] `defineMode` re-adds hooks on every call → N× firing after N reloads — `src/modes/mode.ts:69`
- [ ] region highlight ignores `markActive` → highlight persists after typing — `src/display/build-display-model.ts:117`
- [ ] LSP workspace leak on shutdown; pending requests' timeouts not cleared — `src/lsp/manager.ts:123`, `rpc.ts:80`

### Low
- [ ] cursor-at-newline shifts highlight spans by one cell — `src/ui/text-display.ts:7`
- [ ] `query-replace` always starts from buffer-start, not point — `src/core/emacs-standard.ts:86`
- [ ] isearch `regexpMode` (module global) vs `state.regexp` can diverge — `src/kernel/isearch.ts:14`
- [ ] `:after` advice runs FIFO not LIFO — `src/runtime/advice.ts:67`


## Hot reload (verified broken at layer 3)

- [ ] `load-plugin` prompt + fido: RET concatenates selected candidate with typed input → bad path. Should clear collection when input is absolute.
- [ ] `evaluator.loadPlugin` throws on absolute paths via `import(abs + "?t=...")` — needs `pathToFileURL()` or load-path bypass for `/`-prefixed.
- [ ] `PluginContext` (DESIGN.md §Hot reload): `install(editor, ctx)` where `ctx.command/key/hook/advice` record registrations; `loadPlugin` calls `ctx.dispose()` before re-install. Without this, every reload accumulates hooks/advice.

## Round 3 (from qa-loop at 691f6d2)

- [ ] **fido shows no candidate list** in find-file — `Fido` is in modeline, prompt has trailing `/`, but no vertical list renders. The overlay render path between `plugins/fido` state and `buildDisplayModel` minibuffer area isn't wired (or is wired but not called on initial open).
- [ ] **ESC then C-a → "Unbound key: C-a"** — ESC enters pending (Meta-prefix), C-a arrives, lookup for `ESC C-a` fails and the message shows only `C-a`. Either bind `ESC <key>` → `M-<key>` generically, or fix the pending-state message to show the full sequence.
- [ ] magit's 14 tests sometimes absent from `bun test` batch count — discovery quirk to pin down.

## Bugs (found during plugin work)

- [ ] **`M->` / `M-<` unbound through real terminal.** Bound at `default-bindings.ts:119-120` and works at `handleKey` layer, but echoes "Unbound key:" via OpenTUI. Almost certainly shifted-punctuation normalization: OpenTUI delivers `>` as `{name:'.', shift:true, meta:true}` (or similar) and `keyToken()` canonicalizes to something ≠ `M->`. Fix in `src/kernel/keymap.ts` keyToken/normalizeKey. Layer-3 repro: `scripts/tui-drive.sh start; keys 'M->'`.
- [ ] `proto-renumber` bound at `src/modes/generic.ts:22` but never registered as a command. `test/kernel.test.ts:751` fails on it.
- [ ] `plugins/lsp-watchman/index.ts:97` — `ReadableStream` async-iterator typing under bun-types. Runtime is fine; tsc only.
- [ ] `isearch-regexp`: `setIsearchRegexp` is module-level, so concurrent Editor instances share regexp mode. Move onto `IsearchState`.
- [ ] Preexisting tsc errors in `src/lsp/{capabilities,completion,workspace}.ts`, `src/kernel/command.ts`, `src/ui/opentui-host.ts`, `test/{electron-dom-key,lsp-sync,source}.test.ts`. Not blocking but noisy.

## Architecture — next (from deep-review architect)

- [ ] **`BufferModel._splice`** — make `_text` private with `get text()`; one `_splice(from, to, repl, {markDirty, snapshot})` runs assertWritable→snapshot→onTextChange→mutate→clamp point→adjustMark→deactivateMark in fixed order. All 8 mutators become wrappers. The 5 external `.text =` sites (editor.ts:915,1051; fido:96,113; compile:78) become compile errors → route through setText/append. Closes 9 findings (3 critical). ~15 lines.
- [ ] `Editor.setPointInSelectedWindow(p)` — replaces 4 sites that reach into `windowLayout = setWindowLeafPoint(...)`.
- [ ] Delete `Keymap.pending`/`feed`/`clearPending` (KeymapStack is the only stateful dispatcher).
- [ ] Move 18 1:1-wrapped Editor methods into `lisp/` per DESIGN.md.

## Architecture (from Stephen)

- [ ] **Config split** — see `DESIGN.md` § "Core vs. lisp". Move `src/core/`, `src/config/user.ts`, mode definitions out of the kernel boot path; load them via the same plugin mechanism. Kernel = primitives only.
- [ ] **Hot reload** — see `DESIGN.md` § "Hot reload". `PluginContext` that records registrations and disposes on re-install; `defvar` semantics for module-level state; split `Editor` into stable state-holder + reloadable behavior modules.

## Deferred plugins

- [ ] `term` — pty-backed `*term*` buffer. Needs `node-pty` or Bun's pty if it has one.
- [ ] `mcp-server` — stdio MCP exposing describe-*. Reference: `~/.emacs.d/straight/repos/elisp-dev-mcp/`.
- [ ] `undo-tree` — replace full-buffer-snapshot undo with operation log + tree.
- [ ] `lean4-mode` — 1167 logged commands; needs the InfoView LSP extensions.

## Followups on landed plugins

- [ ] `fido`: candidates appear on first keystroke, not on minibuffer open (avoids readdir race). Match stock icomplete or add `icomplete-show-matches-on-no-input`.
- [ ] `electric-pair`: advice registration is module-flag-guarded; should move to PluginContext once that exists.
- [ ] `windmove`: reference point is window-center, not buffer-point. Fine for v1; revisit if it picks the wrong window in tall splits.
- [ ] `comment-dwim`: line-comments only (no `commentEnd` on Mode yet).
- [ ] `next-error` + `lsp-extras` references both want a shared location-list — they have one each. Unify.

## Infra

- [ ] Auto-load `~/.jemacs/init.ts` and `~/.jemacs/keybinds.js` at boot (one line in `installDefaultConfig`).
- [ ] Layer-3 CI: a `bun test test/tui/` suite that wraps `tui-drive.sh` — catches the keymap-normalization class of bug.
