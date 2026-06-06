# plugins/

Each `<name>/index.ts` exports `install(editor, ctx: PluginContext = createPluginContext(editor))`. Loaded in order from `builtin.ts`, which hands each one a tracked `ctx` so hot-reload disposes the prior install.

Adding a plugin:
1. `plugins/<name>/index.ts` — `editor.command(...)`, `editor.key(...)`, `ctx.minorMode(...)`, `ctx.advice(...)`, `ctx.hook(...)`, `ctx.onDispose(...)` for timers/watchers.
2. `test/plugins/<name>.test.ts` — use `test/harness/` (`script()`, `keySeq()`, `fakeLspServer()`).
3. Register in `builtin.ts`.

State: `defvar(name, initial)` for globals (set-if-unbound, survives reload); `buffer.locals` for per-buffer; `WeakMap<Editor, T>` for per-editor. No module-level `let`.

Hot reload: `C-c C-l` → `evaluator.loadPlugin` → `trackedContext` disposes the prior ctx (removes hooks/advice, runs `onDispose`), then `install(editor, freshCtx)`. Anything registered through `ctx.*` is cleaned up automatically; raw `addHook`/`addAdvice`/`setInterval` will accumulate — don't use them inside `install()`.
