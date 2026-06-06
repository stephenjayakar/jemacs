import { expect, test } from "bun:test"
import { bindJemacsHost } from "../../src/run-core"
import { Editor } from "../../src/kernel/editor"
import type { DisplayModel, InputHandler, UiHost } from "../../src/display/protocol"
import type { ViewportSize } from "../../src/display/viewport"

class StubHost implements UiHost {
  readonly label = "stub"
  readonly capabilities = { unit: "cells" as const, mouse: false, clipboard: false, osc52: false }
  models: DisplayModel[] = []
  async start(): Promise<void> {}
  destroy(): void {}
  present(model: DisplayModel): void { this.models.push(model) }
  getViewport(): ViewportSize { return { rows: 24, cols: 80 } }
  onInput(_h: InputHandler): void {}
  onResize(): void {}
}

// t-72a786a2: top-level command catch dumped error.stack into the one-line echo
// area. Echo should show .message; the stack goes only to *messages*.
test("command error: echo shows .message, stack only in *messages*", async () => {
  const editor = new Editor()
  const { onInput } = bindJemacsHost(editor, new StubHost())

  let echoed = ""
  editor.events.on("message", ({ text }) => { echoed = text })

  editor.command("boom", () => { throw new Error("ENOENT: no such file") })
  editor.key("f9", "boom")
  await onInput({ type: "key", key: { name: "f9" } })

  // echo: single-line message, no V8 stack frames
  expect(echoed).toBe("ENOENT: no such file")
  expect(echoed).not.toContain("\n")

  // *messages*: full stack preserved for debugging
  const messages = [...editor.buffers.values()].find(b => b.name === "*messages*")!
  expect(messages.text).toContain("ENOENT: no such file")
  expect(messages.text).toMatch(/^\s+at /m)
})
