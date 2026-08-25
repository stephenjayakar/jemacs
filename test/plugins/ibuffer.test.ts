import { describe, expect, test } from "bun:test"
import { BufferModel } from "../../src/kernel/buffer"
import type { Editor } from "../../src/kernel/editor"
import { install } from "../../plugins/ibuffer"
import { makeEditor } from "./helper"

function setup(): { editor: Editor; alpha: BufferModel; beta: BufferModel } {
  const editor = makeEditor()
  install(editor)
  const alpha = editor.addBuffer(new BufferModel({
    name: "alpha.txt",
    path: "/tmp/alpha.txt",
    text: "alpha\n",
    mode: "text",
  }))
  const beta = editor.addBuffer(new BufferModel({
    name: "beta.ts",
    path: "/tmp/beta.ts",
    text: "const beta = 1\n",
    mode: "typescript",
  }))
  editor.switchToBuffer(alpha.id)
  return { editor, alpha, beta }
}

function moveToLineContaining(buffer: BufferModel, needle: string): void {
  const line = buffer.text.split("\n").findIndex(row => row.includes(needle))
  expect(line).toBeGreaterThanOrEqual(0)
  buffer.point = buffer.lineStarts[line] ?? 0
}

describe("ibuffer", () => {
  test("opens an ibuffer listing for live buffers", async () => {
    const { editor } = setup()

    await editor.run("ibuffer")

    const buffer = editor.currentBuffer
    expect(buffer.name).toBe("*Ibuffer*")
    expect(buffer.mode).toBe("ibuffer-mode")
    expect(buffer.readOnly).toBe(true)
    expect(buffer.text).toContain("MR")
    expect(buffer.text).toContain("Name")
    expect(buffer.text).toContain("alpha.txt")
    expect(buffer.text).toContain("beta.ts")
  })

  test("d then x kills buffers flagged for deletion", async () => {
    const { editor, alpha, beta } = setup()
    await editor.run("ibuffer")
    const ibuffer = editor.currentBuffer

    moveToLineContaining(ibuffer, "beta.ts")
    await editor.handleKey({ name: "d", sequence: "d" })

    expect(ibuffer.text.split("\n").find(row => row.includes("beta.ts"))?.startsWith("D")).toBe(true)

    await editor.handleKey({ name: "x", sequence: "x" })

    expect(editor.buffers.has(beta.id)).toBe(false)
    expect(editor.buffers.has(alpha.id)).toBe(true)
    expect(editor.currentBuffer.name).toBe("*Ibuffer*")
    expect(ibuffer.text).not.toContain("beta.ts")
  })

  test("RET visits the buffer at point", async () => {
    const { editor, alpha } = setup()
    await editor.run("ibuffer")

    moveToLineContaining(editor.currentBuffer, "alpha.txt")
    await editor.handleKey({ name: "return" })

    expect(editor.currentBufferId).toBe(alpha.id)
    expect(editor.currentBuffer.name).toBe("alpha.txt")
  })
})
