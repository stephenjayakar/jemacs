import { expect, test } from "bun:test"
import { Editor } from "../src/kernel/editor"
import { setCustom } from "../src/runtime/custom"

test("message-log-max caps the *messages* buffer", () => {
  const editor = new Editor()
  setCustom("message-log-max", 10)
  try {
    for (let i = 0; i < 50; i++) editor.message(`line ${i}`)
    const msg = [...editor.buffers.values()].find(b => b.name === "*messages*")!
    const lines = msg.text.split("\n").filter(Boolean)
    expect(lines.length).toBe(10)
    expect(lines.at(-1)!.endsWith("line 49")).toBe(true)
    expect(lines[0]!.endsWith("line 40")).toBe(true)
  } finally {
    setCustom("message-log-max", 1000)
  }
})
