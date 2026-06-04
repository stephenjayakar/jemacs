# Default Emacs keybindings vs Jemacs

GNU Emacs **interactive function names** are the canonical identity of each binding. Jemacs uses the same names in `editor.command(…)` and `editor.key(…)` wherever behavior exists.

**Source of truth:** Commands in `src/core/commands.ts`; default keys in `src/config/default-bindings.ts` (same API as user config). Mode maps under `src/modes/`. Verify live with `M-x describe-bindings` or `M-x describe-key`.

## Legend

| Implementation | Meaning |
| --- | --- |
| **bound** | Key dispatches the named command. |
| **fallback** | `self-insert-command` when no keymap binding matches a printable key. |
| **stub** | Placeholder message only (external packages). |
| **M-x** | Command exists, no default key. |

## Terminal keys (global / minibuffer maps)

| Input | GNU function | Map |
| --- | --- | --- |
| Printable (unbound) | `self-insert-command` | fallback via `handleKey` |
| `left` / `right` | `backward-char` / `forward-char` | global; minibuffer |
| `up` / `down` | `previous-line` / `next-line` | global |
| `up` / `down` | `previous-history-element` / `next-history-element` | minibuffer |
| `backspace` | `delete-backward-char` | global; minibuffer |
| `delete` | `delete-char` | global |
| `RET` / `enter` | `newline` | global |
| `RET` / `enter` | `exit-minibuffer` | minibuffer |
| `esc` | `keyboard-quit` | global |
| `C-u` / `M--` | `universal-argument` / `negative-argument` | global; minibuffer |

## Global map (highlights)

| Key | GNU function | Notes |
| --- | --- | --- |
| `C-/` | `undo` | bound |
| `C-@` | `set-mark-command` | bound |
| `M-y` | `yank-pop` | bound (kill ring) |
| `C-q` | `quoted-insert` | bound |
| `C-t` | `transpose-chars` | bound |
| `C-o` | `open-line` | bound |
| `C-l` | `recenter-top-bottom` | bound |
| `M-<` / `M->` | `beginning-of-buffer` / `end-of-buffer` | bound |
| `M-%` | `query-replace` | bound |
| `M-g g` | `goto-line` | bound (GNU default key) |
| `C-x C-w` | `write-file` | bound |
| `C-x C-v` | `find-alternate-file` | bound |
| `C-x k` | `kill-buffer` | bound |
| `C-x 0` | `delete-window` | bound |
| `C-x 1` | `delete-other-windows` | bound |
| `C-tab` / `C-S-tab` | `other-window` / `other-window-backward` | bound (`C-S-iso-lefttab` too) |
| `C-x o` | `other-window` | bound |
| `C-x 2` | `split-window-below` | bound |
| `C-x 3` | `split-window-right` | bound |
| `C-x u` | `undo` | bound |
| `C-x h` | `mark-whole-buffer` | bound |
| `C-x l` | `count-lines-page` | bound (GNU: line count) |
| `C-x r SPC` / `C-x r j` | `point-to-register` / `jump-to-register` | bound |
| `C-x r k` / `C-x r y` | `kill-rectangle` / `yank-rectangle` | bound |
| `C-x (` / `C-x )` / `C-x e` | macro start / end / call | bound |
| `C-h b/c/e/f/k/v/a/i` | help commands | bound |
| `C-h C-h` | `help-for-help` | bound |
| `C-c d` / `C-c C-d` | registers | **ext** (also `C-x r …`) |

Package chords (`git-link`, `lsp-*`, `gptel`, …) remain **stub**.

## Minibuffer

| Key | GNU function |
| --- | --- |
| `tab` / `C-i` | `minibuffer-complete` |
| `RET` / `C-m` | `exit-minibuffer` |
| `esc` | `abort-recursive-edit` |

## Dired (`S-` = shifted keys)

| Key | GNU function |
| --- | --- |
| `d` | `dired-flag-file-deletion` |
| `S-d` | `dired-do-delete` |
| `u` | `dired-unmark` |
| `S-u` | `dired-unmark-all` |
| `S-c` / `S-r` | `dired-do-copy` / `dired-do-rename` |

## Still missing or partial

| Key | GNU function | Status |
| --- | --- | --- |
| `C-h` alone | `help-command` | **M-x** — prefix keys use full `C-h …` chords |
| `M-y` full Emacs | `yank-pop` | **bound** — simplified kill-ring rotation |
| `C-x C-l` | `load-library` | **ext** — `next-buffer` |
| `C-\\` | `toggle-input-method` | **ext** — `tiling-cycle` |
| `C-h i` reader | `info` | **stub** message |
| `fill-paragraph`, `narrow-*`, frames | various | **missing** |

## Renames (Emacs names)

| Old Jemacs name | GNU name |
| --- | --- |
| `abort-minibuffer` | `abort-recursive-edit` |
| `split-window` | `split-window-below` |
| `show-messages` | `view-echo-area-messages` (use `C-h e`) |
| `inspect-keymap` | `describe-bindings` (`C-h b`) |

Maintaining: after key changes, run tests (`bun test`) and spot-check `describe-bindings`.
