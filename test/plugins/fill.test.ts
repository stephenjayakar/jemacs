import { describe, expect, test } from "bun:test"
import { makeEditor } from "./helper"
import { install } from "../../plugins/fill"
import type { Editor } from "../../src/kernel/editor"

function setup(text: string, fillColumn = 20) {
  const editor = makeEditor()
  install(editor)
  const buffer = editor.currentBuffer
  buffer.setText(text, false)
  buffer.locals.set("fill-column", fillColumn)
  buffer.point = 0
  return { editor, buffer }
}

async function type(editor: Editor, chars: string): Promise<void> {
  for (const ch of chars) await editor.handleKey({ name: ch, sequence: ch })
}

describe("fill-paragraph", () => {
  test("reflows a paragraph at fill-column 20", async () => {
    const { editor, buffer } = setup("alpha beta gamma delta epsilon")
    await editor.run("fill-paragraph")
    expect(buffer.text).toBe("alpha beta gamma\ndelta epsilon")
  })

  test("preserves first and subsequent indentation", async () => {
    const { editor, buffer } = setup("  alpha beta gamma\n    delta epsilon zeta")
    await editor.run("fill-paragraph")
    expect(buffer.text).toBe("  alpha beta gamma\n    delta epsilon\n    zeta")
  })

  test("refills // comment blocks in prog modes", async () => {
    const { editor, buffer } = setup("  // alpha beta gamma\n  // delta epsilon zeta")
    buffer.mode = "javascript"
    await editor.run("fill-paragraph")
    expect(buffer.text).toBe("  // alpha beta\n  // gamma delta\n  // epsilon zeta")
  })

  test("refills # comment blocks in prog modes", async () => {
    const { editor, buffer } = setup("  # alpha beta gamma\n  # delta epsilon zeta")
    buffer.mode = "python"
    await editor.run("fill-paragraph")
    // "  # alpha beta gamma" is exactly 20 columns, so it fits at fill-column 20.
    expect(buffer.text).toBe("  # alpha beta gamma\n  # delta epsilon\n  # zeta")
  })
})

describe("fill-region", () => {
  test("fills two paragraphs in the active region", async () => {
    const { editor, buffer } = setup("alpha beta gamma delta\n\none two three four five")
    buffer.point = 0
    buffer.mark = buffer.text.length
    buffer.markActive = true
    await editor.run("fill-region")
    expect(buffer.text).toBe("alpha beta gamma\ndelta\n\none two three four\nfive")
  })
})

describe("auto-fill-mode", () => {
  test("breaks on space past fill-column", async () => {
    const { editor, buffer } = setup("", 10)
    await editor.run("auto-fill-mode")
    await type(editor, "one two three ")
    expect(buffer.text).toBe("one two\nthree ")
  })
})
