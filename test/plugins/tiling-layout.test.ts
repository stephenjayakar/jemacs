import { describe, expect, test } from "bun:test"
import { script } from "../harness"
import { applyTilingLayout, cycleTilingLayout, tilingLayout, tilingLayouts } from "../../plugins/tiling"
import { BufferModel } from "../../src/kernel/buffer"
import { Editor } from "../../src/kernel/editor"
import { listWindowLeaves, type WindowNode } from "../../src/kernel/window"

/** Give the frame `n` windows, each showing a distinct buffer, selection back on the first. */
async function frameWith(n: number): Promise<Editor> {
  const e = await script().done()
  const first = listWindowLeaves(e.windowLayout)[0]!.id
  for (let i = 1; i < n; i++) {
    const buffer = e.addBuffer(new BufferModel({ name: `pane-${i}`, text: `contents ${i}` }))
    await e.run("split-window-below")
    e.switchToBuffer(buffer.id)
  }
  e.selectWindow(first)
  return e
}

function visibleBuffers(e: Editor): Set<string> {
  return new Set(listWindowLeaves(e.windowLayout).map(leaf => leaf.bufferId))
}

function selectedBuffer(e: Editor): string {
  const leaf = listWindowLeaves(e.windowLayout).find(l => l.id === e.selectedWindowId)
  expect(leaf).toBeDefined()
  return leaf!.bufferId
}

/** Every split ratio equals (leaves on the left) / (leaves in the split). */
function expectBalanced(node: WindowNode): void {
  if (node.kind === "leaf") return
  const first = listWindowLeaves(node.first).length
  const total = first + listWindowLeaves(node.second).length
  expect(Math.abs((node.firstRatio ?? 0) - first / total)).toBeLessThan(1e-9)
  expectBalanced(node.first)
  expectBalanced(node.second)
}

/** Reset the cycle so each test starts from the documented default. */
async function startAtMasterLeft(e: Editor): Promise<void> {
  while (tilingLayout() !== "tiling-master-left") cycleTilingLayout(e)
}

describe("tiling layout application", () => {
  test("cycling from 1 window advances the name but leaves the frame alone", async () => {
    const e = await frameWith(1)
    await startAtMasterLeft(e)
    const before = e.windowLayout

    const next = cycleTilingLayout(e)
    expect(next).toBe("tiling-master-top")
    expect(listWindowLeaves(e.windowLayout)).toHaveLength(1)
    expect(e.windowLayout).toBe(before)
  })

  test("cycling from 2 windows re-tiles and keeps both buffers", async () => {
    const e = await frameWith(2)
    await startAtMasterLeft(e)
    const buffers = visibleBuffers(e)
    const selected = selectedBuffer(e)

    // master-left: one master beside the rest, so the root split is horizontal.
    expect(cycleTilingLayout(e)).toBe("tiling-master-top")
    expect(e.windowLayout.kind).toBe("split")
    if (e.windowLayout.kind === "split") expect(e.windowLayout.direction).toBe("vertical")
    expect(listWindowLeaves(e.windowLayout)).toHaveLength(2)
    expect(visibleBuffers(e)).toEqual(buffers)
    expect(selectedBuffer(e)).toBe(selected)
  })

  test("cycling from 3 windows preserves every visible buffer and the selection", async () => {
    const e = await frameWith(3)
    await startAtMasterLeft(e)
    const buffers = visibleBuffers(e)
    const selected = selectedBuffer(e)
    expect(buffers.size).toBe(3)

    for (let i = 0; i < tilingLayouts().length * 2; i++) {
      cycleTilingLayout(e)
      // tiling-tile-4 does not apply to a 3-window frame; the others all do.
      expect(listWindowLeaves(e.windowLayout)).toHaveLength(3)
      expect(visibleBuffers(e)).toEqual(buffers)
      expect(selectedBuffer(e)).toBe(selected)
    }
  })

  test("cycling from 5 windows preserves buffers and selection across every layout", async () => {
    const e = await frameWith(5)
    await startAtMasterLeft(e)
    const buffers = visibleBuffers(e)
    const selected = selectedBuffer(e)
    expect(buffers.size).toBe(5)

    for (let i = 0; i < tilingLayouts().length; i++) {
      cycleTilingLayout(e)
      expect(listWindowLeaves(e.windowLayout)).toHaveLength(5)
      expect(visibleBuffers(e)).toEqual(buffers)
      expect(selectedBuffer(e)).toBe(selected)
    }
  })

  test("C-\\ through the keymap actually re-tiles the frame", async () => {
    const e = await frameWith(3)
    await startAtMasterLeft(e)
    // Skew the tree so a no-op would be visible: nested vertical splits, unbalanced.
    e.setWindowSplitRatio(e.selectedWindowId, 0.8)
    const before = JSON.stringify(e.windowLayout)

    await e.run("tiling-cycle")

    expect(JSON.stringify(e.windowLayout)).not.toBe(before)
    expectBalanced(e.windowLayout)
  })

  test("tiling-master-left puts the selected buffer in the left master pane", async () => {
    const e = await frameWith(3)
    const selected = selectedBuffer(e)

    expect(applyTilingLayout(e, "tiling-master-left")).toBe(true)
    expect(e.windowLayout.kind).toBe("split")
    if (e.windowLayout.kind !== "split") return
    expect(e.windowLayout.direction).toBe("horizontal")
    expect(e.windowLayout.first.kind).toBe("leaf")
    if (e.windowLayout.first.kind === "leaf") expect(e.windowLayout.first.bufferId).toBe(selected)
    // The two non-master panes stack across the master.
    expect(e.windowLayout.second.kind).toBe("split")
    if (e.windowLayout.second.kind === "split") expect(e.windowLayout.second.direction).toBe("vertical")
  })

  test("tiling-master-top puts the selected buffer in the top master pane", async () => {
    const e = await frameWith(3)
    const selected = selectedBuffer(e)

    expect(applyTilingLayout(e, "tiling-master-top")).toBe(true)
    expect(e.windowLayout.kind).toBe("split")
    if (e.windowLayout.kind !== "split") return
    expect(e.windowLayout.direction).toBe("vertical")
    if (e.windowLayout.first.kind === "leaf") expect(e.windowLayout.first.bufferId).toBe(selected)
    if (e.windowLayout.second.kind === "split") expect(e.windowLayout.second.direction).toBe("horizontal")
  })

  test("tiling-even-horizontal splits only horizontally, evenly", async () => {
    const e = await frameWith(4)

    expect(applyTilingLayout(e, "tiling-even-horizontal")).toBe(true)
    const directions: string[] = []
    const walk = (node: WindowNode): void => {
      if (node.kind === "leaf") return
      directions.push(node.direction)
      walk(node.first)
      walk(node.second)
    }
    walk(e.windowLayout)
    expect(directions).toEqual(["horizontal", "horizontal", "horizontal"])
    expectBalanced(e.windowLayout)
  })

  test("tiling-even-vertical splits only vertically, evenly", async () => {
    const e = await frameWith(4)

    expect(applyTilingLayout(e, "tiling-even-vertical")).toBe(true)
    const directions: string[] = []
    const walk = (node: WindowNode): void => {
      if (node.kind === "leaf") return
      directions.push(node.direction)
      walk(node.first)
      walk(node.second)
    }
    walk(e.windowLayout)
    expect(directions).toEqual(["vertical", "vertical", "vertical"])
  })

  test("tiling-tile-4 builds a 2x2 grid and only applies to four windows", async () => {
    const four = await frameWith(4)
    expect(applyTilingLayout(four, "tiling-tile-4")).toBe(true)
    expect(four.windowLayout.kind).toBe("split")
    if (four.windowLayout.kind !== "split") return
    expect(four.windowLayout.direction).toBe("horizontal")
    expect(four.windowLayout.first.kind).toBe("split")
    expect(four.windowLayout.second.kind).toBe("split")
    if (four.windowLayout.first.kind === "split") expect(four.windowLayout.first.direction).toBe("vertical")
    if (four.windowLayout.second.kind === "split") expect(four.windowLayout.second.direction).toBe("vertical")
    expectBalanced(four.windowLayout)

    const three = await frameWith(3)
    // mutateWindowLayout re-persists point, so compare shape rather than identity.
    const before = JSON.stringify(three.windowLayout)
    expect(applyTilingLayout(three, "tiling-tile-4")).toBe(false)
    expect(JSON.stringify(three.windowLayout)).toBe(before)
  })

  test("re-tiling produces balanced ratios for every layout and window count", async () => {
    for (const count of [2, 3, 4, 5]) {
      for (const layout of tilingLayouts()) {
        const e = await frameWith(count)
        if (!applyTilingLayout(e, layout)) continue
        expect(listWindowLeaves(e.windowLayout)).toHaveLength(count)
        expectBalanced(e.windowLayout)
      }
    }
  })

  test("re-tiling keeps the selected window's point", async () => {
    const e = await frameWith(3)
    e.currentBuffer.point = 0
    const buffer = e.currentBuffer.id

    expect(applyTilingLayout(e, "tiling-even-vertical")).toBe(true)
    expect(e.currentBuffer.id).toBe(buffer)
    const leaf = listWindowLeaves(e.windowLayout).find(l => l.id === e.selectedWindowId)
    expect(leaf?.bufferId).toBe(buffer)
  })

  test("tiling-apply-layout command re-tiles by name", async () => {
    const e = await frameWith(3)
    expect(e.commands.get("tiling-apply-layout")).toBeDefined()

    await e.run("tiling-apply-layout", ["tiling-even-horizontal"])
    expect(e.windowLayout.kind).toBe("split")
    if (e.windowLayout.kind === "split") expect(e.windowLayout.direction).toBe("horizontal")
  })
})
