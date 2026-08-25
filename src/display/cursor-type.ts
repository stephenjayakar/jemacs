import { defcustom, getCustom } from "../runtime/custom"

/** Emacs's `cursor-type`, restricted to the two shapes the hosts can draw.
 *
 *  Char-grid (TUI) hosts always paint the block glyph, so this only changes
 *  hosts that draw their own caret (`perFaceFonts`): "box" makes that caret as
 *  wide as the glyph under point instead of a thin bar. */
defcustom("cursor-type", "string", "bar",
  `Cursor shape in hosts that draw their own caret: "box" or "bar".`, "display")

export function cursorIsBlock(): boolean {
  const type = getCustom<string>("cursor-type")
  return type === "box" || type === "block"
}
