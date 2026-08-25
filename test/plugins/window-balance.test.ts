import { describe, expect, test } from "bun:test"
import { script } from "../harness"
import { BufferModel } from "../../src/kernel/buffer"
import { Editor } from "../../src/kernel/editor"
import { listWindowLeaves, type WindowNode } from "../../src/kernel/window"

/** Every split's ratio equals (leaves left/above) / (leaves in that split). */
function balanceViolations(node: WindowNode, path = "root"): string[] {
  if (node.kind === "leaf") return []
  const first = listWindowLeaves(node.first).length
  const total = first + listWindowLeaves(node.second).length
  const want = first / total
  const bad = Math.abs((node.firstRatio ?? 0) - want) > 1e-9
    ? [`${path}: firstRatio ${node.firstRatio} !== ${want}`]
    : []
  return [...bad, ...balanceViolations(node.first, `${path}.first`), ...balanceViolations(node.second, `${path}.second`)]
}

/** Four balanced windows: the shape every layout command below starts from. */
async function balancedFrame(): Promise<Editor> {
  const e = await script().done()
  await e.run("split-window-below")
  await e.run("other-window")
  await e.run("split-window-right")
  await e.run("split-window-below")
  await e.run("balance-windows")
  expect(listWindowLeaves(e.windowLayout)).toHaveLength(4)
  expect(balanceViolations(e.windowLayout)).toEqual([])
  return e
}

describe("window auto-balance", () => {
  test("splitting keeps every split proportional to its leaf count", async () => {
    const e = await script().done()

    await e.run("split-window-below")
    await e.run("other-window")
    await e.run("split-window-right")
    await e.run("split-window-below")

    expect(listWindowLeaves(e.windowLayout)).toHaveLength(4)
    expect(balanceViolations(e.windowLayout)).toEqual([])
  })

  test("all split aliases auto-balance, matching init.el's advice on split-window", async () => {
    for (const cmd of ["split-window", "split-window-below", "split-window-right", "split-window-horizontally", "split-window-vertically"]) {
      const e = await balancedFrame()
      await e.run(cmd)
      expect(listWindowLeaves(e.windowLayout)).toHaveLength(5)
      expect(balanceViolations(e.windowLayout)).toEqual([])
    }
  })

  test("delete-window and quit-window auto-balance the survivors", async () => {
    for (const cmd of ["delete-window", "quit-window"]) {
      const e = await balancedFrame()
      await e.run(cmd)
      expect(listWindowLeaves(e.windowLayout).length).toBeLessThan(4)
      expect(balanceViolations(e.windowLayout)).toEqual([])
    }
  })

  test("buffer-display commands that reuse or split windows stay balanced", async () => {
    for (const cmd of ["display-buffer", "pop-to-buffer", "switch-to-buffer-other-window"]) {
      const e = await balancedFrame()
      const target = e.addBuffer(new BufferModel({ name: "balance-target", text: "hi" }))
      await e.run(cmd, [target.id])
      expect(balanceViolations(e.windowLayout)).toEqual([])
    }
  })

  test("balance-windows repairs a hand-skewed tree", async () => {
    const e = await balancedFrame()
    e.setWindowSplitRatio(e.selectedWindowId, 0.85)
    expect(balanceViolations(e.windowLayout).length).toBeGreaterThan(0)

    await e.run("balance-windows")
    expect(balanceViolations(e.windowLayout)).toEqual([])
  })

  test("tiling commands leave the frame balanced", async () => {
    // "left" has no neighbour from the pane balancedFrame() selects, so tileMove
    // bails and correctly leaves the layout (skew included) alone.
    for (const cmd of ["tiling-cycle", "tiling-tile-up", "tiling-tile-down", "tiling-tile-right"]) {
      const e = await balancedFrame()
      e.setWindowSplitRatio(e.selectedWindowId, 0.85)
      expect(balanceViolations(e.windowLayout).length).toBeGreaterThan(0)

      await e.run(cmd)
      expect(balanceViolations(e.windowLayout)).toEqual([])
      expect(listWindowLeaves(e.windowLayout)).toHaveLength(4)
    }
  })

  test("a tiling move with no neighbour leaves the layout untouched", async () => {
    const e = await balancedFrame()
    const before = JSON.stringify(e.windowLayout)

    await e.run("tiling-tile-left")
    expect(JSON.stringify(e.windowLayout)).toBe(before)
  })
})
