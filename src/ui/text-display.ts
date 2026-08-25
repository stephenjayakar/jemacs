/** Place the cursor marker in `text` at `point`.
 *
 *  `mode` is "overwrite" for char-grid hosts, where the block glyph occupies
 *  the cell of the character under point (that cell can only hold one glyph).
 *  Hosts that draw their own caret pass "insert": the marker is a placeholder
 *  they strip back out, so it must not consume the character it marks --
 *  overwriting there deletes a character from the rendered buffer. */
export function textWithCursor(
  text: string,
  point: number,
  mode: "overwrite" | "insert" = "overwrite",
): string {
  const cursorPoint = Math.max(0, Math.min(point, text.length))
  const underCursor = text[cursorPoint]
  if (mode === "overwrite" && underCursor && underCursor !== "\n") {
    return text.slice(0, cursorPoint) + "█" + text.slice(cursorPoint + 1)
  }
  return text.slice(0, cursorPoint) + "█" + text.slice(cursorPoint)
}

/** Offsets of the active region inside the string `textWithCursor` returns.
 *
 *  The cursor marker can add a character, which shifts everything after it, so
 *  a span computed against the raw text would be off by one whenever the mark
 *  sits after point. Returns null when there is no region to paint. */
export function regionSpanWithCursor(
  text: string,
  point: number,
  mark: number | null | undefined,
  mode: "overwrite" | "insert" = "overwrite",
): { start: number; end: number } | null {
  if (mark == null) return null
  const clampedPoint = Math.max(0, Math.min(point, text.length))
  const clampedMark = Math.max(0, Math.min(mark, text.length))
  if (clampedPoint === clampedMark) return null
  const inserted = mode === "insert" || !text[clampedPoint] || text[clampedPoint] === "\n"
  const shift = (offset: number) => (inserted && offset > clampedPoint ? offset + 1 : offset)
  return {
    start: shift(Math.min(clampedPoint, clampedMark)),
    end: shift(Math.max(clampedPoint, clampedMark)),
  }
}
