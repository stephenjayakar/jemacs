import { describe, expect, test } from "bun:test"
import { Editor } from "../../src/kernel/editor"
import { addHook, clearHooks } from "../../src/kernel/hooks"

// t-b2cac069 merged batch — editor.ts API cleanup. Most of the batch
// (api-5/7, erro-2/6, step-6, Feat-1/2) landed in be88a61; this covers the
// remaining api--6: addHook/removeHook removed from Editor so the hooks
// registry has a single call path and captureCallerSource depth is uniform.

describe("t-b1c3fe99: hooks registry has one entry point", () => {
  test("Editor exposes runHook but not addHook/removeHook", () => {
    const editor = new Editor()
    expect("addHook" in editor).toBe(false)
    expect("removeHook" in editor).toBe(false)
    expect(typeof editor.runHook).toBe("function")
  })

  test("module-level addHook + editor.runHook still pair", async () => {
    clearHooks()
    const editor = new Editor()
    const seen: string[] = []
    addHook("find-file-hook", ({ editor: ed }) => { seen.push(ed === editor ? "ctx" : "other") })
    await editor.runHook("find-file-hook", editor.currentBuffer)
    expect(seen).toEqual(["ctx"])
    clearHooks()
  })
})
