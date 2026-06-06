import { expect, test } from "bun:test"
import { script } from "../harness"
import { install } from "../../lisp/simple"
import { getCustom } from "../../src/runtime/custom"
import type { Editor } from "../../src/kernel/editor"

// t-audit-4a948630: kill-ring state lived in install()'s closure (`let killRing`,
// `let killRingHistory`), so a hot-reload re-running install() gave a fresh empty
// ring and C-y inserted nothing. defvar's set-if-unbound semantics let the
// backing store outlive the closure (DESIGN.md §Hot-reload fix 2).
test("kill-ring survives lisp/simple re-install (hot-reload)", async () => {
  const editor = await script({ plugins: false })
    .text("survives reload").point(0)
    .run("kill-word")
    .done()
  // simulate reload-plugin: install() runs again, command closures are replaced
  install(editor)
  editor.currentBuffer.setText("")
  editor.currentBuffer.point = 0
  await editor.run("yank")
  expect(editor.currentBuffer.text).toBe("survives")
  // backing store is reachable from the defvar registry, not a private closure
  const rings = getCustom<WeakMap<Editor, string[]>>("kill-ring")
  expect(rings?.get(editor)?.[0]).toBe("survives")
})
