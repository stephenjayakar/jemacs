# Jemacs OpenTUI

A small, self-editable Emacs-like editor prototype where JavaScript replaces Emacs Lisp and OpenTUI renders the terminal frontend.

This is intentionally a starter repo, not a mature editor. The kernel is written so that buffers, commands, keymaps, modes, and the evaluator are ordinary JavaScript/TypeScript objects that can be inspected and modified from inside the editor.

## Runtime and libraries checked

- `@opentui/core` is the only runtime dependency. OpenTUI's current docs describe it as a native Zig terminal UI core with TypeScript bindings and a component/renderable architecture.
- OpenTUI's getting-started docs currently say the TypeScript/JavaScript package is Bun-exclusive, with Node and Deno support in progress, so this repo is Bun-first.
- The OpenTUI docs show `createCliRenderer`, `Box`, `Text`, and `renderer.keyInput.on("keypress", ...)` as the core APIs used here.
- `@types/bun` is included only for TypeScript checking of Bun globals.
- `typescript` is included only for `bun x tsc --noEmit`.

## Install

```bash
bun install
```

If OpenTUI's native package build complains, install Zig. The upstream repo notes that Zig is required to build the packages when native code is involved.

## Run

```bash
bun run dev
# or open a file
bun run src/main.ts README.md
# or self-edit the editor
bun run dev:self
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
| Ctrl-H K | `describe-key` |
| Ctrl-C Ctrl-L | `load-plugin` |
| Ctrl-C Ctrl-R | `reload-current-file` |
| Ctrl-X Ctrl-C or Ctrl-C Ctrl-Q | `save-buffers-kill-terminal` |

## Self-editing demo

1. Start against the editor source:

   ```bash
   bun run src/main.ts src/init/default-commands.ts
   ```

2. Edit a command or add a new one.
3. Mark the relevant JavaScript/TypeScript expression or whole buffer.
4. Press `Ctrl-X Ctrl-E`.
5. Open `*messages*` or inspect the editor with `Ctrl-H E`.

For module-style plugin reloads, use `Ctrl-C Ctrl-L` and enter a plugin path, e.g.:

```text
plugins/demo-plugin.ts
```

The plugin's `install(editor)` function runs against the live editor object.

When visiting a TypeScript or JavaScript file, `Ctrl-C Ctrl-R` saves and cache-bust imports the current file. If the module exports `install(editor)` it is run as a plugin; if it exports `installDefaultCommands(editor)` those commands and keybindings are reinstalled in the running editor.

On macOS, some terminals send Option-key characters instead of Meta events, for example Option-X as `≈`. Jemacs maps the common Option encodings for `M-x`, `M-f`, and `M-b`, and `Esc x` works as the terminal-portable Meta-X fallback.

## Design notes

The editor kernel deliberately avoids OpenTUI imports. That keeps it testable and makes the frontend replaceable. The only OpenTUI-specific file is `src/ui/opentui.ts`.

The evaluator uses Bun's dynamic `Function` constructor rather than a hard security sandbox. Treat evaluated code and plugins as trusted user config, like Emacs Lisp. Do not run hostile plugins.
