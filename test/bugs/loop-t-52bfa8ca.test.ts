import { expect, test } from "bun:test"
import { runJemacsCore } from "../../src/run-core"
import { Editor } from "../../src/kernel/editor"
import type { DisplayModel, InputHandler, ResizeHandler, UiHost } from "../../src/display/protocol"
import type { ViewportSize } from "../../src/display/viewport"

class CountingHost implements UiHost {
  readonly label = "stub"
  readonly capabilities = { unit: "cells" as const, mouse: false, clipboard: false, osc52: false }
  presents = 0
  input!: InputHandler
  async start(): Promise<void> {}
  destroy(): void {}
  present(_m: DisplayModel): void { this.presents++ }
  getViewport(): ViewportSize { return { rows: 24, cols: 80 } }
  onInput(h: InputHandler): void { this.input = h }
  onResize(_h: ResizeHandler): void {}
}

// t-52bfa8ca: run-core's `changed` listener calls present() synchronously, so a
// single keystroke that emits changed N times (command body + run()'s trailing
// emit + message()) drives N full buildDisplayModel passes. The listener should
// coalesce: a sync burst of changed() resolves to one present().
test("t-52bfa8ca: sync burst of changed() coalesces to one present()", async () => {
  const editor = new Editor()
  const host = new CountingHost()
  await runJemacsCore(editor, host)

  host.presents = 0
  void editor.changed("a")
  void editor.changed("b")
  void editor.changed("c")
  await new Promise<void>(r => queueMicrotask(r))

  expect(host.presents).toBe(1)
})
