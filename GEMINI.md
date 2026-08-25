# Jemacs: Architectural Map & Project Relationship Guide

This document explains the codebase layout of **Jemacs**—an Emacs-like editor kernel written in TypeScript, featuring first-class terminal (OpenTUI) and GUI (Electron/Xterm) frontends, a Lisp-inspired TypeScript runtime with hot-reloading, and low-latency remote editing via the "Shadow" sync protocol.

---

## High-Level Architecture

Jemacs separates **Editor State/Logic** (Kernel), **Extension/Commands Runtime** (Lisp & Plugins), **Layout Serialization** (Display Model), and **Frontends** (Hosts).

```
 ┌─────────────────────────────────────────────────────────┐
 │                     LISP & PLUGINS                      │
 │    (lisp/, plugins/, runtime/advice, runtime/hooks)     │
 └────────────────────────────┬────────────────────────────┘
                              ▼
 ┌─────────────────────────────────────────────────────────┐
 │                     JEMACS KERNEL                       │
 │      State (Buffers, Windows, Keymaps, Commands)        │
 └────────────────────────────┬────────────────────────────┘
                              ▼
 ┌─────────────────────────────────────────────────────────┐
 │                     DISPLAY LAYER                       │
 │       Builds DisplayModel (Viewport/Themed Text)        │
 └────────────────────────────┬────────────────────────────┘
                              ▼
 ┌────────────────────────────┴────────────────────────────┐
 │                       UI HOSTS                          │
 │         (ui/opentui-host  <-->  ui/electron-host)       │
 └─────────────────────────────────────────────────────────┘
```

---

## Directory Walkthrough

### 1. `packages/` (The Workspace Packages)
Jemacs is organized as a monorepo workspace to support a future publishable architecture.
*   `@jemacs/core` (`packages/jemacs-core`): Represents the display-agnostic kernel, modes, and runtime re-exported from the root `src/` folder.
*   `@jemacs/host-opentui` (`packages/host-opentui`): Handles terminal frontend binding via the `OpenTuiHost` class.
*   `@jemacs/host-electron` (`packages/host-electron`): Handles Electron GUI frontend binding via the `ElectronHost` class.

### 2. `src/` (The Engine Core)
The primary codebase of Jemacs is partitioned into functional layers:

*   **`kernel/`**: The core data structures of the editor, entirely isolated from display and I/O.
    *   `buffer.ts`: Buffers containing text, local variables, major/minor modes, and modification markers.
    *   `editor.ts`: Core coordinator holding global buffer lists, window layout trees, configuration states, and input-handling routing.
    *   `window.ts`: Layout of windows (leaves containing buffers, nodes containing splits).
    *   `keymap.ts` & `command.ts`: Key registries, key binding tables, and standard command dispatcher mechanics.
*   **`runtime/`**: A "Lisp-in-TypeScript" execution environment.
    *   `evaluator.ts`: Loads, registers, and tracks "plugins" (including core lisp files).
    *   `advice.ts`: Intercepts and wraps function invocations (before, after, around), mimicking Emacs' `advice-add`.
    *   `hooks.ts` & `plugin-context.ts`: Tracks active event hooks, timers, and advisory functions within a disposability wrapper to facilitate perfect hot-reloading.
    *   `live-source.ts`: Powers interactive eval and hot code reload.
*   **`display/`**: The bridge between editor state and rendering hosts.
    *   `build-display-model.ts`: Iterates over the active window layout, resolves themed text faces, adds line numbers, handles scrolling/wrapping, and formats the minibuffer and status line. It compiles everything into a serializable `DisplayModel`.
    *   `protocol.ts`: Defines the serialization/IPC interfaces (`DisplayModel`, `Pane`, `UiHost`, etc.) shared with TUI and GUI hosts.
*   **`ui/`**: Implementations of the rendering hosts.
    *   `select-host.ts`: Detects environmental arguments (e.g. `--gui`) to boot either the TUI or GUI.
    *   `opentui-host.ts` & `opentui.ts`: Wraps terminal I/O using `@opentui/core`.
    *   `electron-host.ts`: Establishes communication with the Electron host wrapper.
*   **`electron/`**: Frontend files for the GUI wrapper.
    *   Bootstrap files (`bootstrap.mjs`, `preload.ts`), renderers (`renderer.ts`, `renderer.html`), and multi-pane xterm integrations (`xterm-panes.ts`).
*   **`modes/`**: Implementations of major and minor modes.
    *   `default-modes.ts`: Registers standard text/prog modes.
    *   `tree-sitter.ts`: Multi-language syntax highlighting utilizing incremental parsing tree-sitter grammars.
    *   `dired.ts`, `minibuffer.ts`, `customize.ts`, `help.ts`: Custom specialized interactive buffers.
*   **`lsp/`**: Deeply integrated, native Language Server Protocol client.
    *   Includes structured JSON-RPC parsing (`rpc.ts`, `jsonrpc.ts`), stdio/TCP sub-processes (`stdio.ts`, `tcp.ts`), and client orchestrations for languages like TypeScript, Go, Lean, Python, Rust, and YAML (`lsp/clients/`).
*   **`xref/`**: Cross-referencing logic (Jump to definition, find references, navigate back/forward).
*   **`shadow/`**: High-performance real-time remote editing sync protocol (see below).

### 3. `lisp/` (Standard Library)
A collection of core interactive text and buffer-manipulation commands written in TypeScript. 
*   These are designed to act exactly like standard Emacs commands.
*   Modules: `simple.ts` (basic movement, editing, registers, kill-ring), `window-cmds.ts` (splitting, resizing, navigation), `files.ts` (opening/saving), `isearch-ui.ts` (incremental search visualization), and `minibuf.ts` (prompt/completion integrations).
*   They are loaded via the `Evaluator` using the tracked context lifecycle, ensuring that they can be live-reloaded safely.

### 4. `plugins/` (Extensions Ecosystem)
Independently-isolated capabilities which are loaded sequentially from `plugins/builtin.ts`.
*   **Lifecycle**: Each plugin exports an `install(editor, ctx: PluginContext)` method. All event hooks, keybindings, and timers must be registered on the provided `ctx` so that they are completely disposed of and re-registered upon hot-reloading (`C-c C-l`).
*   **Builtin Plugins**: Includes `magit` (git UI), `jterm` (embedded terminal emulator in a buffer), `avy` (char jumping), `bookmarks` (persisted points), `electric-pair` (auto-bracket closing), `fido` (interactive completion matching), `compile` (asynchronous compilation buffers), and `tmux-cc` (tmux integration).

### 5. `examples/`
Contains sample programming environments (Go, Lean, Rust, Python, TypeScript) and typical source directories used during manual dogfooding, LSP testing, and integration verification.

### 6. `scripts/`
Housekeeping and automation tools:
*   `build-electron.ts` / `serve-gui-preview.ts`: Bundling tools for GUI frontends.
*   `postinstall-tree-sitter.ts`: Installs and pre-builds C-based tree-sitter language parsers.
*   `shadow-pair.sh`: Boots an Authority (A) and Shadow (S) terminal pair side-by-side to test live synchronization.

---

## Key Core Mechanisms

### 1. The Runtime & Hot Reloading (`C-c C-l`)
Jemacs relies on a modular, self-healing plugin loading system.
*   Module-level state is forbidden; instead, state resides inside `defvar(name, val)` globals (which survive reloads), `buffer.locals` (per-buffer), or `WeakMap<Editor, T>` instances.
*   When executing a reload, `evaluator.loadPlugin` disposes of the previous `PluginContext` (unregistering commands, tearing down listeners, removing advice wraps, and clearing timers) and mounts a clean instance instantly, without interrupting editor process state.

### 2. The "Shadow" Sync Protocol (`src/shadow/`)
Designed for remote-editing with near-zero latency, **Shadow** synchronizes two `Editor` instances: **A** (Authority/Server, e.g., on a remote dev-box running LSP) and **S** (Shadow/Client, e.g., your local laptop).
*   **Optimistic Execution**: S applies user edits immediately to its local buffer and sends operational splices over the wire.
*   **Authority & Rebasing**: A holds the source of truth. When S's predictions diverge from A's state, A sends a `rebase` instruction. S rolls back to the shared baseline, applies A's true edits, transforms its own un-acknowledged edits (shifting offsets/positions), and re-applies them.
*   **Content-Addressed Sync (CAS)**: Instead of shipping large files over the wire, S and A leverage a CAS engine (`~/.jemacs/cas/`) storing text chunks keyed by SHA-256 to minimize sync overhead on connect.

### 3. LSP Bootstrap and Routing
*   **Remote-Aware LSP**: If a buffer is connected via a `ShadowLink`, LSP capabilities (diagnostics, definition jumps, and completion requests) are forwarded to A. A queries the native LSP subprocesses on the remote box and streams the results back to update S's buffers and interactive prompts.

---

## Developer Guide & Workflow

*   **TUI Mode**: `bun run src/main.ts`
*   **GUI Mode**: `bun run dev:gui`
*   **Run All Tests**: `bun test`
*   **Developing a Plugin**: Place your code under `plugins/<your-plugin>/index.ts`, register it in `plugins/builtin.ts`, and test loading live. Use `C-c C-l` in any open buffer to reload your plugin modifications on the fly!
