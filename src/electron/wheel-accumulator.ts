/** Most lines one wheel event can scroll, so one fast flick cannot jump a whole buffer. */
export const MAX_WHEEL_LINES = 10
/** A pause longer than this starts a new gesture and drops the old fractional remainder. */
export const WHEEL_GESTURE_GAP_MS = 200

export const WHEEL_DELTA_PIXEL = 0
export const WHEEL_DELTA_LINE = 1
export const WHEEL_DELTA_PAGE = 2

export interface WheelInput {
  windowId: string
  deltaY: number
  deltaMode: number
  timeStamp: number
}

interface WheelState {
  remainder: number
  direction: number
  lastTime: number
}

/**
 * Converts wheel events to whole-line scrolls.
 *
 * A trackpad sends many small pixel deltas (1-4 px each). The old code rounded each event up
 * to one line, so a light swipe scrolled dozens of lines. This class keeps the fractional
 * rows for each window and sends a line only when a whole row accumulates. The first event
 * of a gesture still scrolls one line at once, so a small mouse-wheel notch is not lost;
 * later pixels pay back that line before the next one scrolls.
 */
export class WheelAccumulator {
  private readonly states = new Map<string, WheelState>()

  constructor(private readonly rowPx: number) {}

  /** Returns the signed line count to scroll now (0 means "do not scroll yet"). */
  lines(input: WheelInput): number {
    if (input.deltaY === 0) return 0
    if (input.deltaMode !== WHEEL_DELTA_PIXEL) {
      // Line and page deltas come from discrete wheels: scroll at once, as before.
      this.states.delete(input.windowId)
      const raw = input.deltaMode === WHEEL_DELTA_LINE ? input.deltaY : input.deltaY * MAX_WHEEL_LINES
      return Math.sign(raw) * Math.min(MAX_WHEEL_LINES, Math.max(1, Math.ceil(Math.abs(raw))))
    }

    const rows = input.deltaY / this.rowPx
    const direction = Math.sign(rows)
    const state = this.states.get(input.windowId)
    // A reversal starts a new gesture, so a stale remainder cannot scroll the wrong way.
    const newGesture = !state
      || input.timeStamp - state.lastTime > WHEEL_GESTURE_GAP_MS
      || state.direction !== direction

    let remainder: number
    let lines: number
    if (newGesture) {
      lines = direction * Math.max(1, Math.trunc(Math.abs(rows)))
      remainder = rows - lines
    } else {
      remainder = state.remainder + rows
      lines = Math.trunc(remainder) || 0 // trunc gives -0 for a negative remainder
      remainder -= lines
    }
    if (Math.abs(lines) > MAX_WHEEL_LINES) lines = Math.sign(lines) * MAX_WHEEL_LINES
    this.states.set(input.windowId, { remainder, direction, lastTime: input.timeStamp })
    return lines
  }
}
