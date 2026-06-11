---
name: qa
description: End-to-end QA for jemacs changes — drive the real TUI in tmux, verify behavior at three layers, catch key-encoding/display bugs that unit tests miss.
---

# QA: testing a jemacs change

Three layers, by fidelity vs speed. Use the lowest layer that can catch the bug class you're worried about; always finish with one layer-3 smoke pass before landing.

## Layer 1 — kernel only

`makeEditor()` from `test/plugins/helper.ts`, then `editor.handleKey({...})` or `await editor.run("cmd")` and assert on `buffer.text`/`buffer.point`/`editor.windowLayout`. No rendering. Every plugin ships a `test/plugins/<name>.test.ts` at this layer.

```ts
import { makeEditor } from "../plugins/helper"
const editor = makeEditor()
await editor.run("find-file", ["/tmp/x.ts"])
await editor.handleKey({ name: "m", meta: true })   // M-m
expect(editor.currentBuffer.point).toBe(...)
```

Run: `bun test test/plugins/<name>.test.ts`

## Layer 2 — DisplayModel snapshot

`buildDisplayModel(editor)` returns the structured render (themed-text rows + window tree) without a terminal. Use for font-lock, viewport, minibuffer-area, window-split layout. See `test/build-display-model.test.ts` for the pattern.

## Layer 3 — real TUI via `scripts/tui-drive.sh`

Drives OpenTUI in a real pty inside tmux. Catches key-encoding bugs (shifted punctuation, ESC-prefix vs meta), terminal capability issues, and anything where the bug is between OpenTUI's raw input and `handleKey`.

```bash
scripts/tui-drive.sh start [file]           # 120×35 pane, waits for first frame
scripts/tui-drive.sh keys C-x C-f "src/main.ts" Enter
scripts/tui-drive.sh wait 'typescript.*main\.ts' 5
scripts/tui-drive.sh modeline               # → " typescript Lin  main.ts  line 1, col 1"
scripts/tui-drive.sh cap                    # full screen, plain text
scripts/tui-drive.sh capansi                # with SGR (assert on colour)
scripts/tui-drive.sh stop
```

`keys` arguments: tmux key names (`C-x` `M-m` `C-M-s` `Enter` `Space` `Tab` `BSpace` `Escape` `Up`/`Down`/etc.) are sent as keystrokes; anything else is typed literally. Put literal text in quotes so the shell doesn't split it.

Set `JEMACS_TMUX_SESSION` to run multiple instances side-by-side.

`tui-drive.sh` exports `JEMACS_INIT_PATH=test/fixtures/empty-config.ts` so a broken `~/.jemacs/init.ts` does not break tmux probes.

## Layer 3b — Emacs parity (tmux)

For Emacs ports (major modes, personal hooks), drive **Stephen's Emacs** the same way and diff behavior:

```bash
scripts/emacs-drive.sh start examples/docs/guide.md
scripts/emacs-drive.sh keys End Enter C-x C-s
scripts/emacs-drive.sh cap
scripts/emacs-drive.sh stop

JEMACS_PARITY_EMACS=1 npx bun test test/tui/markdown-parity.test.ts
```

Do not use `emacs --batch` for markdown-mode parity: `my-markdown-mode-hook` calls `markdown-display-inline-images`, which errors in batch. Use `emacs-drive.sh` (`emacs -nw` in tmux) instead.

## Pre-land checklist

1. `bun test` — full suite green (the one preexisting `proto-renumber` failure is known).
2. `bun run check` — no new tsc errors (4 preexisting in test files).
3. Layer-3 smoke: `start`, exercise the changed keybindings through the real terminal, `cap` and eyeball, `stop`.
4. If the change touches key dispatch, font-lock, or the minibuffer, add a layer-2 assertion.

## Known traps

- Layer-1 tests build `KeyEventLike` by hand, so they never see the OpenTUI→`keyToken` normalization path. Shifted-punctuation bindings (`M->`, `C-_`) can pass at layer 1 and fail at layer 3.
- `tmux send-keys` echoes nothing, but jemacs's echo area doesn't auto-clear — a stale message from a previous key can mislead. `keys C-g` first to clear.
- `bun run check` sees all WIP plugins; for a single-plugin typecheck during a parallel build, `grep` its path from the output instead.
