import { expect, test } from "bun:test"
import { bindJemacsHost } from "../src/run"
import { Editor } from "../src/kernel/editor"
import type { DisplayModel, InputHandler, UiHost } from "../src/display/protocol"
import type { ViewportSize } from "../src/display/viewport"

class StubHost implements UiHost {
  readonly label = "stub"
  readonly capabilities = { unit: "cells" as const, mouse: false, clipboard: false, osc52: false }
  models: DisplayModel[] = []
  inputs: InputHandler[] = []

  async start(): Promise<void> {}
  destroy(): void {}
  present(model: DisplayModel): void {
    this.models.push(model)
  }
  getViewport(): ViewportSize {
    return { rows: 24, cols: 80 }
  }
  onInput(handler: InputHandler): void {
    this.inputs.push(handler)
  }
  onResize(): void {}
}

test("bindJemacsHost presents and routes paste input", async () => {
  const editor = new Editor()
  editor.scratch("bind", "", "text")
  const host = new StubHost()
  const { present, onInput } = bindJemacsHost(editor, host)
  present()
  expect(host.models.length).toBe(1)
  await onInput({ type: "paste", text: "hi" })
  expect(editor.currentBuffer.text).toBe("hi")
})
