# jdap-mode

`jdap-mode` is Jemacs's Debug Adapter Protocol client. It reads the same
`.vscode/launch.json` used by VS Code and presents a shared Run and Debug UI in
the OpenTUI and Electron hosts.

## Quick start

1. Install the relevant external adapter:
   - Python: make `debugpy` importable by `python3`, or customize
     `jdap-python-command`.
   - JavaScript/TypeScript: install Microsoft's `js-debug` or set
     `jdap-node-adapter-path`/`JEMACS_JS_DEBUG_PATH` to its
     `src/dapDebugServer.js`.
2. Open a project containing `.vscode/launch.json`.
3. Run `M-x jdap-debug` (`C-c d d`) and select a configuration or compound.

Without a `launch.json`, Python and Node source buffers receive an in-memory
current-file configuration. `M-x jdap-create-launch-json` can write that
configuration after confirmation.

## Main commands

| Command | Key |
| --- | --- |
| Start / continue | `F5` |
| Start last configuration | `C-c d l` |
| Select configuration | `C-c d d` |
| Toggle breakpoint | `F9`, `C-c d b` |
| Step over / in / out | `F10`, `F11`, `S-F11` |
| Continue / pause | `C-c d c`, `F6` |
| Stop | `S-F5`, `C-c d q` |
| Evaluate / add watch | `C-c d e`, `C-c d w` |
| Toggle debugger UI | `C-c d u` |

While jdap is installed, `C-c d` becomes the debugger prefix; the previous
personal register shortcut remains available through GNU Emacs's canonical
`C-x r SPC` binding.

Breakpoints and watches are stored outside the project in
`~/.jemacs/jdap-state.json`. Adapter-specific `launch.json` properties are
preserved and passed through after VS Code-style variable and input expansion.
