import { describe, expect, test } from "bun:test"
import { listWindowLeaves } from "../../src/kernel/window"
import { keySeq } from "../harness"
import { makeEditor } from "./helper"
import {
  EDIFF_CONTROL_BUFFER_NAME,
  EDIFF_CURRENT_A_FACE,
  EDIFF_OVERLAYS_LOCAL,
  EDIFF_SESSION_LOCAL,
  ediffSession,
  ediffSpans,
  install,
} from "../../plugins/ediff"

function setup() {
  const editor = makeEditor()
  install(editor)
  const a = editor.scratch("A", "one\ntwo\nthree\nfour\n", "text")
  const b = editor.scratch("B", "one\nTWO\nthree\nFOUR\n", "text")
  return { editor, a, b }
}

async function startEdiff() {
  const state = setup()
  await state.editor.run("ediff-buffers", ["A", "B"])
  const control = state.editor.currentBuffer
  const session = ediffSession(control)
  if (!session) throw new Error("missing Ediff session")
  return { ...state, control, session }
}

describe("ediff plugin", () => {
  test("two buffers with known differences produce the right diff count", async () => {
    const { session } = await startEdiff()

    expect(session.diffs.length).toBe(2)
    expect(session.currentIndex).toBe(-1)
  })

  test("n moves to the first difference and highlights it", async () => {
    const { editor, a, b, session } = await startEdiff()

    await keySeq(editor, "n")

    expect(session.currentIndex).toBe(0)
    expect(a.point).toBe(a.text.indexOf("two"))
    expect(b.point).toBe(b.text.indexOf("TWO"))
    expect(ediffSpans(a)).toContainEqual({ start: 4, end: 8, face: EDIFF_CURRENT_A_FACE })
    expect(editor.fontLock(a)).toContainEqual({ start: 4, end: 8, face: EDIFF_CURRENT_A_FACE })
  })

  test("a copies the current A region into B", async () => {
    const { editor, b, session } = await startEdiff()

    await keySeq(editor, "n")
    await keySeq(editor, "a")

    expect(b.text).toBe("one\ntwo\nthree\nFOUR\n")
    expect(session.diffs.length).toBe(1)
    expect(session.currentIndex).toBe(0)
  })

  test("q removes overlays, kills the control buffer, and restores the old layout", async () => {
    const { editor, a, b, control } = await startEdiff()
    await keySeq(editor, "n")

    expect(ediffSpans(a).length).toBeGreaterThan(0)
    expect(listWindowLeaves(editor.windowLayout).length).toBe(3)

    await keySeq(editor, "q")

    expect(a.locals.has(EDIFF_OVERLAYS_LOCAL)).toBe(false)
    expect(b.locals.has(EDIFF_OVERLAYS_LOCAL)).toBe(false)
    expect(control.locals.has(EDIFF_SESSION_LOCAL)).toBe(false)
    expect([...editor.buffers.values()].some(buffer => buffer.name === EDIFF_CONTROL_BUFFER_NAME)).toBe(false)
    expect(listWindowLeaves(editor.windowLayout).length).toBe(1)
  })
})
