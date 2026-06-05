import { expect, test } from "bun:test"
import { Editor } from "../../src/kernel/editor"
import { BufferModel } from "../../src/kernel/buffer"
import { installDefaultModes } from "../../src/modes/default-modes"
import * as linum from "../../src/modes/linum-mode"

// t-03f8df43: showLineNumbers was a prototype method whose body hardcoded
// "linum-mode", and linum-mode.onEnable reassigned it on the instance —
// method-as-mutable-slot defeats the type contract. Fix: showLineNumbers is a
// declared function-valued slot (like `completer`) defaulting to () => false,
// and linum-mode exports linumActiveFor() so build-display-model can drop the
// slot entirely once it's free to.

test("t-03f8df43: showLineNumbers is a slot, not a prototype method linum reassigns", () => {
  // Kernel carries no linum knowledge: nothing on the prototype, default off.
  expect(Object.getOwnPropertyDescriptor(Editor.prototype, "showLineNumbers")).toBeUndefined()
  const bare = new Editor()
  expect(bare.showLineNumbers(bare.currentBuffer)).toBe(false)

  // linum-mode exports the predicate directly.
  expect(typeof (linum as Record<string, unknown>).linumActiveFor).toBe("function")

  // After enabling, the slot is wired to linumActiveFor and gating still holds.
  installDefaultModes()
  const editor = new Editor()
  editor.enableMinorMode("linum-mode")
  const file = editor.addBuffer(new BufferModel({ name: "f.ts", path: "/tmp/f.ts", kind: "file" }))
  const special = editor.addBuffer(new BufferModel({ name: "*grep*", kind: "scratch" }))
  expect(editor.showLineNumbers(file)).toBe(true)
  expect(editor.showLineNumbers(special)).toBe(false)
  expect(linum.linumActiveFor(editor, file)).toBe(true)
  expect(linum.linumActiveFor(editor, special)).toBe(false)
})
