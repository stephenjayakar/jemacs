import { expect, test } from "bun:test"
import {
  MAX_WHEEL_LINES,
  WHEEL_DELTA_LINE,
  WHEEL_DELTA_PAGE,
  WHEEL_DELTA_PIXEL,
  WHEEL_GESTURE_GAP_MS,
  WheelAccumulator,
} from "../src/electron/wheel-accumulator"

const ROW = 18
const px = (deltaY: number, timeStamp: number, windowId = "w") =>
  ({ windowId, deltaY, deltaMode: WHEEL_DELTA_PIXEL, timeStamp })

test("a trackpad swipe of small pixel deltas scrolls in proportion to distance", () => {
  const wheel = new WheelAccumulator(ROW)
  let total = 0
  // 90 events of 2 px = 180 px = 10 rows. The old code scrolled 90 lines.
  for (let i = 0; i < 90; i++) total += wheel.lines(px(2, i * 8))
  expect(total).toBe(10)
})

test("the first event of a gesture scrolls at once, even below one row", () => {
  const wheel = new WheelAccumulator(ROW)
  expect(wheel.lines(px(4, 0))).toBe(1)
  expect(wheel.lines(px(-4, 1000))).toBe(-1)
})

test("a pause starts a new gesture", () => {
  const wheel = new WheelAccumulator(ROW)
  expect(wheel.lines(px(4, 0))).toBe(1)
  expect(wheel.lines(px(4, 10))).toBe(0)
  expect(wheel.lines(px(4, 10 + WHEEL_GESTURE_GAP_MS + 1))).toBe(1)
})

test("a direction change scrolls the new way at once", () => {
  const wheel = new WheelAccumulator(ROW)
  expect(wheel.lines(px(4, 0))).toBe(1)
  expect(wheel.lines(px(-4, 10))).toBe(-1)
})

test("each window keeps its own remainder", () => {
  const wheel = new WheelAccumulator(ROW)
  expect(wheel.lines(px(4, 0, "a"))).toBe(1)
  expect(wheel.lines(px(4, 5, "b"))).toBe(1)
  expect(wheel.lines(px(4, 10, "a"))).toBe(0)
})

test("line and page deltas scroll at once and stay capped", () => {
  const wheel = new WheelAccumulator(ROW)
  expect(wheel.lines({ windowId: "w", deltaY: 3, deltaMode: WHEEL_DELTA_LINE, timeStamp: 0 })).toBe(3)
  expect(wheel.lines({ windowId: "w", deltaY: -1, deltaMode: WHEEL_DELTA_PAGE, timeStamp: 1 })).toBe(-MAX_WHEEL_LINES)
  expect(wheel.lines(px(10_000, 2))).toBe(MAX_WHEEL_LINES)
})
