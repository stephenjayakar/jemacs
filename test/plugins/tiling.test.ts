import { describe, expect, test } from "bun:test"
import { script } from "../harness"
import { tilingLayout, tileMove } from "../../plugins/tiling"
import { listWindowLeaves } from "../../src/kernel/window"

describe("tiling", () => {
  test("kernel has no tiling state", async () => {
    const e = await script({ plugins: false }).done()
    expect((e as Record<string, unknown>).tilingLayout).toBeUndefined()
    expect((e as Record<string, unknown>).cycleTilingLayout).toBeUndefined()
  })

  test("plugin defines tiling-cycle on C-\\ and cycles via defvar", async () => {
    const e = await script().done()
    expect(e.keymaps.describe("C-\\")?.command).toBe("tiling-cycle")
    expect(tilingLayout()).toBe("tiling-master-left")
    await e.run("tiling-cycle")
    expect(tilingLayout()).toBe("tiling-master-top")
  })

  test("tiling-tile-* commands and keys are registered", async () => {
    const e = await script().done()
    for (const dir of ["up", "down", "left", "right"]) {
      expect(e.commands.get("tiling-tile-" + dir)).toBeDefined()
    }
    expect(e.keymaps.describe("C-M-left")?.command).toBe("tiling-tile-left")
    expect(e.keymaps.describe("C-M-right")?.command).toBe("tiling-tile-right")
  })

  test("tileMove is a no-op with a single window", async () => {
    const e = await script().done()
    expect(listWindowLeaves(e.windowLayout)).toHaveLength(1)
    expect(tileMove(e, "right")).toBe(false)
    expect(listWindowLeaves(e.windowLayout)).toHaveLength(1)
  })

  test("tileMove relocates the buffer and preserves the window count", async () => {
    const e = await script().done()
    // Two side-by-side windows, then move the left buffer into the right one.
    await e.run("split-window-right")
    const before = listWindowLeaves(e.windowLayout).length
    expect(before).toBe(2)

    const movedBuffer = e.currentBuffer.id
    const ok = tileMove(e, "right")
    expect(ok).toBe(true)
    // One window deleted, one created by the split: the count is unchanged.
    expect(listWindowLeaves(e.windowLayout)).toHaveLength(before)
    // The buffer travelled with the move and the new window is selected.
    const selected = listWindowLeaves(e.windowLayout)
      .find(leaf => leaf.id === e.selectedWindowId)
    expect(selected?.bufferId).toBe(movedBuffer)
  })
})
