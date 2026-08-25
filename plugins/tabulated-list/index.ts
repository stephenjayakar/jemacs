import type { BufferModel } from "../../src/kernel/buffer"
import type { Editor } from "../../src/kernel/editor"
import { Keymap } from "../../src/kernel/keymap"
import { defineMode, type TableSurfaceModel } from "../../src/modes/mode"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"

export const TABULATED_LIST_STATE_LOCAL = "tabulated-list-state"
export const TABULATED_LIST_REVERT_LOCAL = "tabulated-list-revert-function"

export type TabulatedListCell = string | number | boolean | null | undefined
export type TabulatedListColumn = {
  name: string
  width: number
  sortable?: boolean
  align?: "left" | "right" | "center"
}
export type TabulatedListEntry = {
  id: string
  cells: TabulatedListCell[]
  marked?: boolean
}
export type TabulatedListRenderOptions = {
  columns: TabulatedListColumn[]
  entries: TabulatedListEntry[]
  sortColumn?: string | null
  sortReverse?: boolean
}
export type TabulatedListRefresh = (buffer: BufferModel) => unknown | Promise<unknown>
export type TabulatedListRenderedColumn = TabulatedListColumn & {
  index: number
  offset: number
  width: number
}
export type TabulatedListState = {
  columns: TabulatedListRenderedColumn[]
  entries: TabulatedListEntry[]
  sourceColumns: TabulatedListColumn[]
  sourceEntries: TabulatedListEntry[]
  sortColumn: string | null
  sortReverse: boolean
}

const HEADER_LINES = 1

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  const keymap = new Keymap("tabulated-list-mode-map")
  for (const key of ["n", "C-n", "down"]) keymap.bind(key, "next-line")
  for (const key of ["p", "C-p", "up"]) keymap.bind(key, "previous-line")
  keymap.bind("s", "tabulated-list-sort")
  keymap.bind("S-s", "tabulated-list-sort")
  keymap.bind("g", "tabulated-list-revert")

  defineMode({
    name: "tabulated-list-mode",
    parent: "text",
    keymap,
    onEnter: buffer => { buffer.readOnly = true },
    tableSurface: tabulatedListTableSurface,
    mouseClick(buffer, point) {
      buffer.point = point
      if (buffer.lineAt(point) !== 0) return true
      const column = tabulatedListColumnAtPoint(buffer)
      return column ? tabulatedListSortColumn(buffer, column.name) : true
    },
  })

  ctx.command("tabulated-list-sort", ({ buffer, editor }) => {
    const state = tabulatedListState(buffer)
    const column = tabulatedListColumnAtPoint(buffer)
      ?? state?.columns.find(c => c.name === state.sortColumn)
      ?? state?.columns.find(c => c.sortable)
    if (!column?.sortable) {
      editor.message("No sortable column here")
      return
    }
    if (tabulatedListSortColumn(buffer, column.name)) {
      const state = tabulatedListState(buffer)
      editor.message(`Sort by ${column.name}${state?.sortReverse ? " descending" : ""}`)
      void editor.changed("tabulated-list-sort")
    }
  }, "Sort the current tabulated-list column.")

  ctx.command("tabulated-list-revert", async ({ buffer, editor }) => {
    const refresh = buffer.locals.get(TABULATED_LIST_REVERT_LOCAL) as TabulatedListRefresh | undefined
    if (!refresh) {
      editor.message("No refresh function for this tabulated list")
      return
    }
    await refresh(buffer)
    void editor.changed("tabulated-list-revert")
  }, "Refresh the current tabulated list.")
}

export function renderTabulatedList(buffer: BufferModel, options: TabulatedListRenderOptions): void {
  const oldEntry = tabulatedListEntryAtPoint(buffer)?.id ?? null
  const oldColumn = tabulatedListColumnAtPoint(buffer)?.name ?? null
  const oldLine = buffer.lineAt(buffer.point)
  const oldCol = buffer.point - (buffer.lineStarts[oldLine] ?? 0)

  const sourceColumns = options.columns.map(column => ({ ...column, width: Math.max(1, column.width) }))
  const sourceEntries = options.entries.map(entry => ({ ...entry, cells: [...entry.cells] }))
  const sortIndex = sourceColumns.findIndex(column => column.sortable && column.name === options.sortColumn)
  const sortColumn = sortIndex >= 0 ? sourceColumns[sortIndex]!.name : null
  const sortReverse = options.sortReverse === true
  const columns = renderedColumns(sourceColumns, sortColumn, sortReverse)
  const entries = sortedEntries(sourceEntries, sortIndex, sortReverse)

  const header = columns.map(column => justify(headerLabel(column, sortColumn, sortReverse), column.width, column.align)).join(" ")
  const rows = entries.map(entry => columns
    .map(column => justify(cellText(entry.cells[column.index]), column.width, column.align))
    .join(" "))

  buffer.locals.set(TABULATED_LIST_STATE_LOCAL, {
    columns,
    entries,
    sourceColumns,
    sourceEntries,
    sortColumn,
    sortReverse,
  } satisfies TabulatedListState)
  buffer.setText([header, ...rows].join("\n"), false, false)
  buffer.readOnly = true
  restorePoint(buffer, oldEntry, oldColumn, oldLine, oldCol)
}

export function tabulatedListState(buffer: BufferModel): TabulatedListState | null {
  return (buffer.locals.get(TABULATED_LIST_STATE_LOCAL) as TabulatedListState | undefined) ?? null
}

export function tabulatedListEntryAtPoint(buffer: BufferModel): TabulatedListEntry | null {
  const state = tabulatedListState(buffer)
  if (!state) return null
  const line = buffer.lineAt(buffer.point)
  if (line < HEADER_LINES) return null
  return state.entries[line - HEADER_LINES] ?? null
}

export function tabulatedListColumnAtPoint(buffer: BufferModel): TabulatedListRenderedColumn | null {
  const state = tabulatedListState(buffer)
  if (!state) return null
  const line = buffer.lineAt(buffer.point)
  const col = buffer.point - (buffer.lineStarts[line] ?? 0)
  return state.columns.find(column => col >= column.offset && col < column.offset + column.width) ?? null
}

export function tabulatedListSortColumn(buffer: BufferModel, columnName: string): boolean {
  const state = tabulatedListState(buffer)
  const column = state?.columns.find(candidate => candidate.name === columnName)
  if (!state || !column?.sortable) return false
  const sortReverse = state.sortColumn === column.name ? !state.sortReverse : false
  renderTabulatedList(buffer, {
    columns: state.sourceColumns,
    entries: state.sourceEntries,
    sortColumn: column.name,
    sortReverse,
  })
  return true
}

function renderedColumns(columns: TabulatedListColumn[], sortColumn: string | null, sortReverse: boolean): TabulatedListRenderedColumn[] {
  let offset = 0
  return columns.map((column, index) => {
    const width = Math.max(1, column.width, headerLabel({ ...column, index, offset, width: column.width }, sortColumn, sortReverse).length)
    const rendered = { ...column, index, offset, width }
    offset += rendered.width + 1
    return rendered
  })
}

function sortedEntries(entries: TabulatedListEntry[], sortIndex: number, reverse: boolean): TabulatedListEntry[] {
  if (sortIndex < 0) return entries
  const sign = reverse ? -1 : 1
  return [...entries].sort((a, b) => {
    const byCell = compareCells(a.cells[sortIndex], b.cells[sortIndex])
    return byCell ? byCell * sign : a.id.localeCompare(b.id) * sign
  })
}

function compareCells(a: TabulatedListCell, b: TabulatedListCell): number {
  if (typeof a === "number" && typeof b === "number") return a - b
  const an = numericCell(a)
  const bn = numericCell(b)
  if (an != null && bn != null) return an - bn
  return cellText(a).localeCompare(cellText(b))
}

function numericCell(cell: TabulatedListCell): number | null {
  if (typeof cell === "number") return cell
  if (typeof cell !== "string" || !/^-?\d+(?:\.\d+)?$/.test(cell.trim())) return null
  const parsed = Number(cell)
  return Number.isFinite(parsed) ? parsed : null
}

function headerLabel(column: TabulatedListRenderedColumn, sortColumn: string | null, reverse: boolean): string {
  if (column.name !== sortColumn) return column.name
  return `${column.name}${reverse ? "▼" : "▲"}`
}

function cellText(cell: TabulatedListCell): string {
  if (cell == null) return ""
  return String(cell)
}

function cellValue(cell: TabulatedListCell): string | number | boolean | undefined {
  return cell == null ? undefined : cell
}

function justify(text: string, width: number, align: TabulatedListColumn["align"] = "left"): string {
  const clipped = text.length > width ? text.slice(0, Math.max(0, width - 1)) + "~" : text
  if (align === "right") return clipped.padStart(width)
  if (align === "center") {
    const left = Math.floor((width - clipped.length) / 2)
    return " ".repeat(left) + clipped + " ".repeat(width - clipped.length - left)
  }
  return clipped.padEnd(width)
}

function restorePoint(buffer: BufferModel, oldEntry: string | null, oldColumn: string | null, oldLine: number, oldCol: number): void {
  const state = tabulatedListState(buffer)
  if (!state) {
    buffer.point = Math.min(buffer.point, buffer.text.length)
    return
  }
  const entryIndex = oldEntry ? state.entries.findIndex(entry => entry.id === oldEntry) : -1
  if (entryIndex >= 0) {
    const line = entryIndex + HEADER_LINES
    const column = oldColumn ? state.columns.find(candidate => candidate.name === oldColumn) : undefined
    buffer.point = (buffer.lineStarts[line] ?? buffer.text.length) + (column?.offset ?? 0)
    return
  }
  const maxLine = Math.max(0, state.entries.length)
  const line = Math.max(0, Math.min(oldLine, maxLine))
  const lineStart = buffer.lineStarts[line] ?? buffer.text.length
  const [start, end] = buffer.lineBounds(line)
  buffer.point = Math.min(lineStart + oldCol, end, buffer.text.length)
  if (lineStart < start) buffer.point = start
}

function tabulatedListTableSurface(buffer: BufferModel): TableSurfaceModel | null {
  const state = tabulatedListState(buffer)
  if (!state) return null
  const pointLine = buffer.lineAt(buffer.point)
  return {
    kind: "table",
    columns: state.columns.map(column => ({
      key: column.name,
      label: column.name,
      align: column.align,
      width: column.width,
      sortable: column.sortable,
      sortDirection: state.sortColumn === column.name ? state.sortReverse ? "desc" : "asc" : undefined,
    })),
    rows: state.entries.map((entry, i) => {
      const cells: TableSurfaceModel["rows"][number]["cells"] = {}
      for (const column of state.columns) {
        const cell = entry.cells[column.index]
        cells[column.name] = { text: cellText(cell), value: cellValue(cell) }
      }
      return {
        id: entry.id,
        line: i + HEADER_LINES,
        selected: pointLine === i + HEADER_LINES,
        marked: entry.marked,
        cells,
      }
    }),
    emptyText: "No entries",
  }
}
