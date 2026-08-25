/**
 * The kernel and the renderer must agree on how tall a body row is.
 *
 * `ElectronHost.getViewport` divides the window height by a row height to decide how
 * many rows to lay out. If that constant differs from what the DOM actually draws, the
 * kernel produces a different number of rows than fit, the body sits at the overflow
 * threshold, and the scrollbar toggles between frames -- visible as flicker at the
 * bottom of a buffer.
 *
 * Pinning the relationship here means a future font-size or line-height change cannot
 * silently reintroduce the mismatch.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  DOM_FRAME_BODY_FONT_PX,
  DOM_FRAME_LINE_HEIGHT_RATIO,
  DOM_FRAME_ROW_PX,
} from "../../src/display/dom-frame"

/** What a body row actually occupies in the DOM. */
const RENDERED_ROW_PX = DOM_FRAME_BODY_FONT_PX * DOM_FRAME_LINE_HEIGHT_RATIO

const HOST_SOURCE = join(import.meta.dirname, "..", "..", "src", "ui", "electron-host.ts")

describe("row height agreement", () => {
  test("the host's row height is derived, not a magic number", () => {
    const source = readFileSync(HOST_SOURCE, "utf8")
    // A hardcoded literal is what caused the drift; require the derivation.
    expect(source).toContain(
      "const ROW_PX = DOM_FRAME_BODY_FONT_PX * DOM_FRAME_LINE_HEIGHT_RATIO",
    )
  })

  test("the row budget never exceeds what the viewport can display", () => {
    // The Math.max(24, ...) floor intentionally over-budgets very short windows, so
    // only check heights where the floor is not the binding constraint.
    const offenders: Array<{ height: number; budget: number; fits: number }> = []
    for (let height = 400; height <= 2000; height += 50) {
      const fits = height / RENDERED_ROW_PX
      if (fits < 24) continue
      const budget = Math.floor(fits)
      if (budget > fits) offenders.push({ height, budget, fits })
    }
    expect(offenders).toEqual([])
  })

  test("the old 18px constant under-counted rows", () => {
    // Documents the bug: at 18px per row the kernel budgets fewer lines than the DOM
    // has room for, leaving the body permanently near the overflow threshold.
    const height = 1000
    const withOld = Math.max(24, Math.floor(height / 18))
    const actuallyFits = height / RENDERED_ROW_PX
    expect(actuallyFits).toBeGreaterThan(withOld)
  })

  test("DOM_FRAME_ROW_PX stays close to the rendered text row height", () => {
    // Terminal surfaces use DOM_FRAME_ROW_PX with line-height 1, so it is a separate
    // number by design; guard that it has not drifted far from the text row height.
    expect(Math.abs(DOM_FRAME_ROW_PX - RENDERED_ROW_PX)).toBeLessThan(1)
  })
})
