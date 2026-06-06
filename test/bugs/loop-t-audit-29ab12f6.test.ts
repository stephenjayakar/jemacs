import { expect, test } from "bun:test"
import * as core from "../../packages/jemacs-core"
import * as runtime from "../../src/runtime/jemacs-runtime"

// t-audit-29ab12f6 — @jemacs/core index is stale vs the documented surface.
// README.md: "Eval and plugins receive the full runtime (src/runtime/jemacs-runtime.ts):
//   defcustom, defineMode, addHook, addAdvice, Editor, and more."
// DESIGN.md: PluginContext is the per-plugin registration surface.
// packages/README.md: "@jemacs/core | Kernel, display/, runJemacs".
// The index only re-exported kernel/editor + display/{protocol,build-display-model}
// + run, so the documented runtime surface, BufferModel, Keymap, and PluginContext
// were unreachable from the package root.

test("@jemacs/core re-exports the documented runtime surface (README.md)", () => {
  // Every value-level export of jemacs-runtime.ts must be reachable from the
  // package root — that file *is* the documented public surface.
  const missing = Object.keys(runtime).filter(k => !(k in core))
  expect(missing).toEqual([])
  // Spot-check the names README.md calls out by string.
  expect(typeof (core as any).defcustom).toBe("function")
  expect(typeof (core as any).defvar).toBe("function")
  expect(typeof (core as any).defineMode).toBe("function")
  expect(typeof (core as any).addHook).toBe("function")
  expect(typeof (core as any).addAdvice).toBe("function")
})

test("@jemacs/core re-exports kernel + PluginContext (DESIGN.md, packages/README.md)", () => {
  expect(typeof (core as any).BufferModel).toBe("function")
  expect(typeof (core as any).Keymap).toBe("function")
  expect(typeof (core as any).createPluginContext).toBe("function")
})

test("@jemacs/core does NOT export host bootstrap (Stephen split: hosts are separate packages)", () => {
  expect(typeof core.Editor).toBe("function")
  expect((core as Record<string, unknown>).runJemacs).toBeUndefined()
  expect((core as Record<string, unknown>).bindJemacsHost).toBeUndefined()
})
