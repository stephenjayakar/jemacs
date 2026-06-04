# Default Emacs keybindings vs Jemacs

GNU Emacs uses **interactive command names** (Lisp functions) as the canonical identity of each binding. Jemacs registers the same names wherever behavior exists; this file maps keys → **GNU Emacs function** → what Jemacs actually binds and runs.

**Source of truth for installed keys:** `installDefaultCommands()` in `src/init/default-commands.ts` (global bindings from `editor.key(…)`), `defineKey("minibuffer", …)`, and mode installers in `src/modes/`. Verify in a running editor with `M-x describe-bindings` or `M-x describe-key`.

## Legend

| Implementation | Meaning |
| --- | --- |
| **bound** | Key is on `global-map`, `minibuffer-local-map`, or a major-mode map and dispatches the named command. |
| **hardcoded** | `Editor.handleKey()` performs the same effect without going through the keymap (see below). |
| **stub** | Command exists but only shows a placeholder message (packages not integrated). |
| **M-x** | Command registered; no default key in Jemacs. |
| **missing** | Standard GNU binding not implemented. |

| GNU key match | Meaning |
| --- | --- |
| **yes** | Same key and same function name as GNU Emacs defaults. |
| **key** | Same function, different key in Jemacs (noted). |
| **no** | Function exists in Jemacs but GNU uses a different default key. |
| **ext** | Jemacs-specific or third-party chord, not a GNU default. |

---

## Hardcoded dispatch (`Editor.handleKey`)

These are not in the keymap but match normal Emacs behavior:

| Input | GNU Emacs function | Implementation |
| --- | --- | --- |
| Printable | `self-insert-command` | **hardcoded** — inserts via buffer API |
| `left` / `right` | `backward-char` / `forward-char` | **hardcoded** — same motion as bound `C-b` / `C-f` |
| `up` / `down` (buffer) | `previous-line` / `next-line` | **hardcoded** |
| `up` / `down` (minibuffer) | `previous-history-element` / `next-history-element` | **hardcoded** — history only |
| `backspace` (buffer) | `delete-backward-char` | **hardcoded** — `delete-backward-char` is also **M-x** |
| `delete` | `delete-char` | **hardcoded** |
| `RET` (buffer) | `newline` | **hardcoded** — `C-m` also **bound** to `newline` |
| `RET` (minibuffer) | `exit-minibuffer` | **hardcoded** — calls submit; `C-m`/`enter` also **bound** |
| `esc` (alone) | `keyboard-quit` | **hardcoded** — runs `keyboard-quit` |

---

## Global map (`global-map`)

All entries below are installed by `installDefaultCommands()`. **Jemacs command** is always the symbol passed to `editor.key` (matches GNU name when **GNU key** is **yes**).

| Key | GNU Emacs function | GNU key | Implementation |
| --- | --- | --- | --- |
| `C-SPC` | `set-mark-command` | yes | **bound** |
| `C-@` | `set-mark-command` | yes | **missing** (use `C-SPC`) |
| `C-a` | `move-beginning-of-line` | yes | **bound** |
| `C-b` | `backward-char` | yes | **bound** |
| `C-d` | `delete-char` | yes | **bound** |
| `C-e` | `move-end-of-line` | yes | **bound** |
| `C-f` | `forward-char` | yes | **bound** |
| `C-g` | `keyboard-quit` | yes | **bound** |
| `C-h b` | `describe-bindings` | yes | **bound** |
| `C-h c` | `describe-mode` | yes | **bound** |
| `C-h e` | `view-echo-area-messages` | yes | **bound** |
| `C-h k` | `describe-key` | yes | **bound** |
| `C-i` / `tab` | `indent-for-tab-command` | yes | **bound** |
| `C-j` | `newline-and-indent` | yes | **bound** |
| `C-k` | `kill-line` | yes | **bound** |
| `C-m` | `newline` | yes | **bound** |
| `C-n` | `next-line` | yes | **bound** |
| `C-p` | `previous-line` | yes | **bound** |
| `C-r` | `isearch-backward` | yes | **bound** |
| `C-s` | `isearch-forward` | yes | **bound** |
| `C-u` | `universal-argument` | yes | **bound** |
| `C-v` | `scroll-up-command` | yes | **bound** |
| `C-w` | `kill-region` | yes | **bound** |
| `C-y` | `yank` | yes | **bound** |
| `C-_` | `undo` | yes | **bound** |
| `C-/` | `undo` | yes | **missing** |
| `C-\\` | `toggle-input-method` | no | **ext** — `tiling-cycle` (**stub** layout helper) |
| `C-tab` | — | ext | **ext** — `next-window-any-frame` (**bound**) |
| `C-S-tab` | — | ext | **ext** — `previous-window-any-frame` (**bound**) |
| `C-M-tab` | `complete-symbol` (often) | no | **ext** — `tab-bar-switch-to-next-tab` (**bound**) |
| `C-M-S-tab` | — | ext | **ext** — `tab-bar-switch-to-prev-tab` (**bound**) |
| `M-b` / `esc b` | `backward-word` | yes | **bound** |
| `M-d` / `esc d` | `kill-word` | yes | **bound** |
| `M-f` / `esc f` | `forward-word` | yes | **bound** |
| `M-h` / `M-backspace` / `esc backspace` | `backward-kill-word` | yes | **bound** |
| `M-v` | `scroll-down-command` | yes | **bound** |
| `M-w` | `kill-ring-save` | yes | **bound** |
| `M-x` / `esc x` | `execute-extended-command` | yes | **bound** |
| `M-y` | `yank-pop` | yes | **missing** |
| `C-x C-b` | `list-buffers` | yes | **bound** |
| `C-x C-c` | `save-buffers-kill-terminal` | yes | **bound** |
| `C-x C-e` | `eval-defun` / `eval-region` | yes | **bound** — `eval-region` (JS eval) |
| `C-x C-f` | `find-file` | yes | **bound** |
| `C-x C-r` | `revert-buffer` | yes | **bound** |
| `C-x C-s` | `save-buffer` | yes | **bound** |
| `C-x C-x` | `exchange-point-and-mark` | yes | **bound** |
| `C-x b` | `switch-to-buffer` | yes | **bound** |
| `C-x d` | `dired` | yes | **bound** |
| `C-x o` | `other-window` | yes | **bound** |
| `C-x C-j` | — | ext | **ext** — `previous-buffer` (**bound**) |
| `C-x C-l` | `load-library` | no | **ext** — `next-buffer` (**bound**) |
| `C-x l` | `goto-line` | no | **key** — GNU default is `M-g g`; **bound** in Jemacs |
| `C-x f` | `set-fill-column` | no | **ext** — `fzf-git` (**bound**) |
| `C-x C-a` | — | ext | **ext** — `lsp-execute-code-action` (**stub**) |
| `C-c C-d` | `jump-to-register` | no | **key** — GNU `C-x r j`; **bound** |
| `C-c d` | `point-to-register` | no | **key** — GNU `C-x r SPC`; **bound** |
| `C-c r` | `replace-string` | no | **key** — not global in GNU; **bound** |
| `C-c C-l` | — | ext | **ext** — `load-plugin` (**bound**) |
| `C-c C-r` | — | ext | **ext** — `reload-current-file` (**bound**) |
| `C-c C-q` | `save-buffers-kill-terminal` | no | **key** — extra quit chord; **bound** |
| `C-c g l` | `git-link` | ext | **stub** |
| `C-c g m` | `magit-find-main` | ext | **stub** |
| `C-c p` | `projectile-command-map` | ext | **stub** |
| `C-c SPC` | `ace-jump-word-mode` | ext | **stub** |
| `C-c C-x SPC` | `ace-jump-char-mode` | ext | **stub** |
| `C-c RET` | `yafolding-toggle-element` | ext | **stub** |
| `C-c t` | `lsp-find-definition` | ext | **stub** |
| `C-c C-t` | `lsp-ui-peek-find-implementation` | ext | **stub** |
| `s-f` | `counsel-ag` | ext | **bound** (ripgrep) |
| `s-g` | `gptel` | ext | **stub** |
| `s-m` | `gptel-menu` | ext | **stub** |
| `s-r` | `restart-emacs` | ext | **stub** |
| `s-t` | `tab-bar-new-tab` | ext | **bound** |
| `s-w` | `tab-bar-close-tab` | ext | **bound** |
| `s-{` / `s-}` | `tab-bar-switch-to-prev-tab` / `tab-bar-switch-to-next-tab` | ext | **bound** |

### Commands registered but not on `global-map` (M-x)

| GNU Emacs function | Implementation |
| --- | --- |
| `clear-mark` | **M-x** |
| `delete-backward-char` | **M-x** (buffer `backspace` is **hardcoded**) |
| `delete-window` | **M-x** |
| `describe-key-briefly` | **M-x** |
| `eval-expression` | **M-x** |
| `i-bind-key` | **M-x** (Jemacs: persist custom `editor.key`) |
| `load-theme` | **M-x** |
| `next-buffer` | **bound** on `C-x C-l` only |
| `previous-buffer` | **bound** on `C-x C-j` only |
| `redo` | **M-x** |
| `show-messages` | **M-x** (same buffer as `view-echo-area-messages`) |
| `split-window-below` | **M-x** as `split-window` |
| `proto-add-rpc` | **M-x** (Jemacs protobuf helper) |
| `proto-renumber` | **bound** in `protobuf-mode` only |
| `copy-region-to-clipboard-mac` | **M-x** |
| `stephen-emacs-mcp-copy-codex-config` | **M-x** |
| `stephen-emacs-mcp-doctor` | **M-x** |

---

## Minibuffer (`minibuffer-local-map`)

| Key | GNU Emacs function | GNU key | Implementation |
| --- | --- | --- | --- |
| `tab` / `C-i` | `minibuffer-complete` | yes | **bound** |
| `RET` / `C-m` / `enter` | `exit-minibuffer` | yes | **bound** (+ **hardcoded** `RET`) |
| `esc` | `abort-minibuffer` | partial | **bound** (GNU often uses `C-g` → `abort-recursive-edit`) |
| `backspace` | `delete-backward-char` | yes | **bound** |
| `C-g` | `keyboard-quit` | yes | **bound** via global map |

---

## Dired mode (`dired-mode-map`)

Resolved after `normalizeToken()` (letters lowercased). Known collision: `d`/`D`, `c`/`C`, `u`/`U` — only one binding per letter survives.

| Key | GNU Emacs function | GNU key | Implementation |
| --- | --- | --- | --- |
| `RET` | `dired-find-file` | yes | **bound** |
| `g` | `dired-revert` | yes | **bound** |
| `^` | `dired-up-directory` | yes | **bound** |
| `q` | `quit-window` | yes | **bound** |
| `m` | `dired-mark` | yes | **bound** |
| `u` | `dired-unmark-all` | no | **bound** — GNU `u` is `dired-unmark` (**missing** on key) |
| `t` | `dired-toggle-mark` | yes | **bound** |
| `% .` | `dired-mark-all` | yes | **bound** |
| `% m` | `dired-mark-files-regexp` | yes | **bound** |
| `% d` | `dired-flag-files-regexp` | yes | **bound** |
| `d` | `dired-do-delete` | no | **bound** — GNU `d` is `dired-flag-file-deletion` (**missing** on key) |
| `x` | `dired-do-flagged-delete` | yes | **bound** |
| `c` | `dired-do-copy` | yes | **bound** (`C` in source) |
| `r` | `dired-do-rename` | yes | **bound** (`R` in source) |
| `+` | `dired-create-directory` | yes | **bound** |
| `backspace` | `dired-unmark-backward` | yes | **bound** |

---

## Python mode (`python-mode-map`)

| Key | GNU Emacs function | GNU key | Implementation |
| --- | --- | --- | --- |
| `C-M-a` | `python-beginning-of-defun` | yes | **bound** |
| `C-M-e` | `python-end-of-defun` | yes | **bound** |
| `C-c C-z` | `python-shell-switch-to-shell` | yes | **bound** — placeholder shell buffer |

---

## Common GNU defaults not in Jemacs

| Key | GNU Emacs function | Implementation |
| --- | --- | --- |
| `C-h f` | `describe-function` | **missing** |
| `C-h v` | `describe-variable` | **missing** |
| `C-h a` | `apropos-command` | **missing** |
| `C-h i` | `info` | **missing** |
| `C-h` / `C-h` | `help-command` / `help-for-help` | **missing** |
| `C-x C-w` | `write-file` | **missing** |
| `C-x C-v` | `find-alternate-file` | **missing** |
| `C-x k` | `kill-buffer` | **missing** |
| `C-x 0` | `delete-window` | **M-x** `delete-window` |
| `C-x 1` | `delete-other-windows` | **missing** |
| `C-x 2` | `split-window-below` | **M-x** `split-window` |
| `C-x 3` | `split-window-right` | **missing** |
| `C-x u` | `undo` | **missing** |
| `C-x h` | `mark-whole-buffer` | **missing** |
| `C-l` | `recenter-top-bottom` | **missing** |
| `M-<` / `M->` | `beginning-of-buffer` / `end-of-buffer` | **missing** |
| `M-%` | `query-replace` | **missing** |
| `C-q` | `quoted-insert` | **missing** |
| `C-t` | `transpose-chars` | **missing** |
| `C-o` | `open-line` | **missing** |
| `C-x (` / `C-x )` / `C-x e` | `start-kbd-macro` / `end-kbd-macro` / `call-last-kbd-macro` | **missing** |
| `C-x r k` / `C-x r y` | `kill-rectangle` / `yank-rectangle` | **missing** |

---

## Maintaining this file

1. After changing `editor.key` / `defineKey` / mode keymaps, re-run:
   ```bash
   npx bun -e "
   import { Editor } from './src/kernel/editor.ts'
   import { installDefaultCommands } from './src/init/default-commands.ts'
   import { installDefaultModes } from './src/modes/default-modes.ts'
   installDefaultModes()
   const e = new Editor()
   installDefaultCommands(e)
   for (const [k,v] of e.keymap.all().sort((a,b)=>a[0].localeCompare(b[0])))
     console.log(k, v)
   "
   ```
2. Update tables if counts or names drift.
3. Keep **Jemacs command** column identical to the string in `editor.key(…)` — that is the implementation contract.

Counts (current tree): **80** global, **6** minibuffer, **16** dired, **3** python, **1** protobuf.
