# Jemacs OpenTUI

_Pronounced "jee-macs"_.

A self-editable Emacs-like editor where JavaScript replaces Emacs Lisp and **pluggable frontends** render the UI: **OpenTUI** (terminal) and **Electron** (GUI).

This is a work-in-progress and doesn't have a major release yet. Lots of rough edges and have generally implemented the feature set that I need for work instead of all of Emacs's functionality.

We've implemented some default plugins in `plugins/`. You can find additional ones in https://github.com/stephenjayakar/jemacs-packages/.

## Run

**Terminal (default):**

```bash
bun run dev
# or open a file
bun run src/main.ts README.md
```

**GUI (Electron):**

```bash
bun run build:gui   # once, or before first GUI launch
bun run dev:gui
# same as: JEMACS_UI=electron bun run dev
# or: bun run src/main.ts --gui
```

Both hosts share the same kernel (`src/kernel/`), display model (`src/display/`), and bootstrap (`src/run.ts`).

Optional: native OpenTUI editor surface for the selected window (no font-lock in that pane):

```bash
JEMACS_USE_TEXTAREA=1 bun run dev
```

## Keybindings

Commands use **GNU Emacs function names** (`find-file`, `kill-region`, `execute-extended-command`, …). Full tables with implementation status: [DEFAULT_KEYBINDINGS.md](DEFAULT_KEYBINDINGS.md).

| Key | Emacs command |
| --- | --- |
| Type printable keys | `self-insert-command` |
| Return or Ctrl-J/Ctrl-M | `newline` / `newline-and-indent` |
| Backspace | `delete-backward-char` |
| Left/Right or Ctrl-B/Ctrl-F | `backward-char` / `forward-char` |
| Up/Down or Ctrl-P/Ctrl-N | `previous-line` / `next-line` |
| Ctrl-A / Ctrl-E | `move-beginning-of-line` / `move-end-of-line` |
| Meta-B / Meta-F | `backward-word` / `forward-word` |
| Ctrl-D | `delete-char` |
| Ctrl-K / Ctrl-Y | `kill-line` / `yank` |
| Ctrl-W / Meta-W | `kill-region` / `kill-ring-save` |
| Ctrl-X Ctrl-S | `save-buffer` |
| Ctrl-X Ctrl-E | `eval-region` |
| Ctrl-X B | `switch-to-buffer` |
| Ctrl-X Ctrl-B | `list-buffers` |
| Ctrl-X Ctrl-F | `find-file` |
| Ctrl-Space | `set-mark-command` |
| Ctrl-G | `keyboard-quit` |
| Meta-X / Alt-X / Esc X | `execute-extended-command` |
| Ctrl-H E | `view-echo-area-messages` |
| Ctrl-H C | `describe-mode` |
| Ctrl-H B | `describe-bindings` |
| Ctrl-H F | `describe-function` (RET → source) |
| Ctrl-H V | `describe-variable` |
| Ctrl-H K | `describe-key` |
| C-M-x | `eval-defun` |
| Meta-G G | `goto-line` |
| Ctrl-X 2 / Ctrl-X 3 | `split-window-below` / `split-window-right` |
| Ctrl-X K | `kill-buffer` |
| Ctrl-C Ctrl-L | `load-plugin` |
| Ctrl-C Ctrl-R | `reload-current-file` |
| Ctrl-X Ctrl-C or Ctrl-C Ctrl-Q | `save-buffers-kill-terminal` |

## Self-modifying Jemacs (Emacs-style)

Everything registered through the public extension API is live, source-tracked, and patchable:

| Kind | Define with | Describe | Patch at point | Revert |
| --- | --- | --- | --- | --- |
| Command | `editor.command(...)` | `C-h f` | `C-M-x` (`eval-defun`) | `M-x revert-function` |
| Variable | `defcustom` / `defvar` | `C-h v` | `C-M-x` | `M-x revert-definition` |
| Key | `editor.key` / `editor.defineKey` | `C-h k` | `C-M-x` | `M-x revert-definition` |
| Mode | `defineMode(...)` | `C-h c` | `C-M-x` | `M-x revert-definition` |
| Hook | `addHook(...)` | `M-x find-definition` | `C-M-x` | `M-x revert-definition` |
| Advice | `addAdvice(...)` | `M-x find-definition` | `C-M-x` | `M-x revert-definition` |

Help buffers use **help mode**: put point on a `Source:` line (or the described name) and press **RET** (`help-follow`) to jump to the definition. `M-x find-definition` covers any registered kind.

**Temporary** changes: `C-M-x` on a definition form (or `C-x C-e` on a region). **Permanent**: edit the file, `C-x C-s`, then `C-c C-r` (`reload-current-file`) or `M-x load-file`. Reload clears all temporary patches first, then re-imports the module.

Eval and plugins receive the full runtime (`src/runtime/jemacs-runtime.ts`): `defcustom`, `defineMode`, `addHook`, `addAdvice`, `Editor`, and more. You can also patch `Editor.prototype` in a scratch buffer for kernel-level experiments (advanced; restart Jemacs to fully reset class state).

```bash
bun run dev:self   # opens src/main.ts
bun run src/main.ts path/to/file.ts
```

Startup config modules can be loaded with `--config <path>`. `~/.jemacs/init.ts` is auto-loaded when present. Config modules should export `install(editor)` or `installDefaultConfig(editor)`.

Module plugins: `C-c C-l` (`load-plugin`). File buffers: `C-c C-r` (`reload-current-file`) when the file exports `install(editor)` or `installDefaultConfig(editor)`.

On macOS, some terminals send Option-key characters instead of Meta events, for example Option-X as `≈`, Option-v as `√`, and Option-. as `≥`. Jemacs maps the common Option encodings (including `M-v` from `√`); the Electron GUI uses the physical key (`KeyboardEvent.code`) for Option chords. `Esc` plus the key (e.g. `Esc .` for xref) works as a terminal-portable Meta fallback.

### Kitty and Ctrl+Tab

`C-tab` / `C-S-tab` run GNU `other-window` and `other-window-backward` (cycle Emacs windows). Jemacs enables Kitty’s keyboard protocol when OpenTUI supports it.

**Kitty binds Ctrl+Tab to its own tab bar by default**, so the keys may never reach Jemacs. Add to `~/.config/kitty/kitty.conf`:

```
map ctrl+tab
map ctrl+shift+tab
```

(Empty `map` lines remove Kitty’s binding.) Restart Kitty, then split a window in Jemacs (`C-x 2`) and try again. Fallback: `C-x o` (forward) — always works.

If a key still fails, check the echo area after pressing it: unbound keys show the resolved token and raw escape sequence.

## Design notes

The editor kernel deliberately avoids OpenTUI and Electron imports. Display output is built in `src/display/build-display-model.ts` as a host-agnostic `DisplayModel`; hosts only paint it:

| Host | Module |
| --- | --- |
| Terminal | `src/ui/opentui-host.ts` (`OpenTuiHost`) |
| GUI | `src/ui/electron-host.ts` (`ElectronHost`) |

OpenTUI key translation stays in `src/ui/opentui-key.ts`. Entry: `src/main.ts` (TUI or `--gui`) / `src/main-electron.ts` (GUI-only).

**Core vs config:** Interactive commands live in `src/core/commands.ts` (no key bindings). Default GNU keybindings are in `src/config/default-bindings.ts` using the same `editor.key()` / `editor.defineKey()` API as plugins and user config. Startup calls `installDefaultConfig(editor)` from `src/config/index.ts`. Override keys in a plugin or `~/.jemacs/init.ts` by calling `editor.key(...)` after defaults load.

The evaluator uses Bun's dynamic `Function` constructor rather than a hard security sandbox. Treat evaluated code and plugins as trusted user config, like Emacs Lisp. Do not run hostile plugins.
