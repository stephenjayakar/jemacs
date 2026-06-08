import type { ThemedChunk, ThemedText } from "./themed-text"

export const TERMINAL_SURFACE_LOCAL = "terminal-surface"

export type TerminalCell = {
  text: string
  fg?: string
  bg?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
}

export type TerminalSurfaceModel = {
  kind: "terminal"
  rows: number
  cols: number
  cursorRow: number
  cursorCol: number
  cells: TerminalCell[][]
}

export function terminalSurfaceToThemedText(surface: TerminalSurfaceModel): ThemedText {
  const chunks: ThemedChunk[] = []
  const push = (chunk: ThemedChunk) => {
    const last = chunks.at(-1)
    if (last && sameStyle(last, chunk)) {
      last.text += chunk.text
      return
    }
    chunks.push(chunk)
  }
  for (let y = 0; y < surface.rows; y++) {
    if (y > 0) push({ text: "\n" })
    const row = surface.cells[y] ?? []
    for (let x = 0; x < surface.cols; x++) {
      const cell = row[x] ?? { text: " " }
      const atCursor = y === surface.cursorRow && x === surface.cursorCol
      push({
        text: cell.text || " ",
        fg: atCursor ? (cell.bg ?? "#1e1e1e") : cell.fg,
        bg: atCursor ? (cell.fg ?? "#d4d4d4") : cell.bg,
        bold: cell.bold,
        italic: cell.italic,
        underline: cell.underline,
      })
    }
  }
  return { chunks }
}

function sameStyle(a: ThemedChunk, b: ThemedChunk): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold
    && a.italic === b.italic && a.underline === b.underline
    && a.family === b.family && a.height === b.height
    && a.heightScale === b.heightScale
}
