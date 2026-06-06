import { expect, test } from "bun:test"
import { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { install } from "../../lisp/simple"

// t-audit-96a71b85: simple.ts called editor.events.on("changed", …) and
// editor.addOverlaySource(…) at install time without routing teardown through
// ctx.onDispose. Evaluator.loadPlugin disposes the prior PluginContext and
// re-runs install() on every hot reload, so each reload stacked another
// "changed" listener and another overlay-source closure on the editor. The
// listener now registers its off-handle with ctx.onDispose; the overlay source
// is registered once per Editor (defvar/WeakMap guard, mirroring kill-ring)
// since the kernel has no removeOverlaySource yet.
test("simple.ts: reload via PluginContext does not stack listeners or overlay sources", () => {
  const editor = new Editor()
  const overlays = (editor as unknown as { overlaySources: unknown[] }).overlaySources
  const listeners = (editor.events as unknown as { listeners: Map<string, Set<unknown>> }).listeners

  let ctx: PluginContext | undefined
  for (let i = 0; i < 3; i++) {
    ctx?.dispose()
    ctx = createPluginContext(editor)
    install(editor, ctx)
  }

  expect(listeners.get("changed")?.size).toBe(1)
  expect(overlays.length).toBe(1)
})
