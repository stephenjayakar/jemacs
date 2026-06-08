import type { FaceName } from "../../src/modes/mode"

/** Map the 16-colour ANSI palette onto the closest existing font-lock face.
 *  Mirrors plugins/term-v2/ANSI_FACES; kept independent so the two plugins
 *  can theme differently without coupling. */
export const ANSI_FACES: Readonly<Record<number, FaceName>> = {
  0: "comment",
  1: "error",
  2: "string",
  3: "function",
  4: "directory",
  5: "type",
  6: "constant",
  7: "default",
  8: "comment",
  9: "error",
  10: "string",
  11: "function",
  12: "directory",
  13: "type",
  14: "constant",
  15: "default",
}

const ANSI_HEX = [
  "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
  "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
]

export function xtermPaletteHex(index: number): string | undefined {
  if (index >= 0 && index < ANSI_HEX.length) return ANSI_HEX[index]
  if (index >= 16 && index <= 231) {
    const n = index - 16
    const r = Math.floor(n / 36)
    const g = Math.floor((n % 36) / 6)
    const b = n % 6
    return rgbTripletHex(cubeLevel(r), cubeLevel(g), cubeLevel(b))
  }
  if (index >= 232 && index <= 255) {
    const v = 8 + (index - 232) * 10
    return rgbTripletHex(v, v, v)
  }
  return undefined
}

function cubeLevel(n: number): number {
  return n === 0 ? 0 : 55 + n * 40
}

function rgbTripletHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("")}`
}

export function rgbHex(value: number): string {
  return `#${(value & 0xffffff).toString(16).padStart(6, "0")}`
}
