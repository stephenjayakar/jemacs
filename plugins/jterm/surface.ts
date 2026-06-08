import type { TerminalCell, TerminalSurfaceModel } from "../../src/display/terminal-surface"
import { rgbHex, xtermPaletteHex } from "./ansi-faces"

type IBuffer = { baseY: number; cursorY: number; cursorX: number; getLine(y: number): IBufferLine | undefined; getNullCell(): IBufferCell }
type IBufferLine = { getCell(x: number, cell: IBufferCell): boolean }
type IBufferCell = {
  getWidth(): number
  getChars(): string
  isBold(): boolean
  isItalic(): boolean
  isUnderline(): boolean
  isFgDefault(): boolean
  isBgDefault(): boolean
  isFgRGB(): boolean
  isBgRGB(): boolean
  isFgPalette(): boolean
  isBgPalette(): boolean
  getFgColor(): number
  getBgColor(): number
}
type XTermLike = { rows: number; cols: number; buffer: { active: IBuffer } }

const SCRATCH_CELL: IBufferCell = {} as IBufferCell

/** Build a TerminalSurfaceModel from the headless xterm viewport (the visible
 *  rows, NOT scrollback). Cells outside the viewport are not walked. */
export function buildSurface(xt: XTermLike): TerminalSurfaceModel {
  const buf = xt.buffer.active
  const rows = xt.rows
  const cols = xt.cols
  const cells: TerminalCell[][] = new Array(rows)
  const scratch = buf.getNullCell()
  for (let y = 0; y < rows; y++) {
    const line = buf.getLine(buf.baseY + y)
    const row: TerminalCell[] = new Array(cols)
    for (let x = 0; x < cols; x++) {
      if (!line?.getCell(x, scratch) || scratch.getWidth() === 0) {
        row[x] = { text: " " }
        continue
      }
      row[x] = cellToTerminalCell(scratch)
    }
    cells[y] = row
  }
  return {
    kind: "terminal",
    rows,
    cols,
    cursorRow: Math.max(0, Math.min(rows - 1, buf.cursorY)),
    cursorCol: Math.max(0, Math.min(cols - 1, buf.cursorX)),
    cells,
  }
}

function cellToTerminalCell(cell: IBufferCell): TerminalCell {
  const out: TerminalCell = { text: cell.getChars() || " " }
  if (cell.isBold()) out.bold = true
  if (cell.isItalic()) out.italic = true
  if (cell.isUnderline()) out.underline = true
  const fg = cellColor(cell, "fg")
  const bg = cellColor(cell, "bg")
  if (fg) out.fg = fg
  if (bg) out.bg = bg
  return out
}

function cellColor(cell: IBufferCell, part: "fg" | "bg"): string | undefined {
  const isDefault = part === "fg" ? cell.isFgDefault() : cell.isBgDefault()
  if (isDefault) return undefined
  const isRgb = part === "fg" ? cell.isFgRGB() : cell.isBgRGB()
  const isPalette = part === "fg" ? cell.isFgPalette() : cell.isBgPalette()
  const value = part === "fg" ? cell.getFgColor() : cell.getBgColor()
  let result: string | undefined
  if (isRgb) result = rgbHex(value)
  else if (isPalette) result = xtermPaletteHex(value)
  return result
}

export type { IBuffer, IBufferCell, IBufferLine, XTermLike }
