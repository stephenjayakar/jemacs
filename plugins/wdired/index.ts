import { dirname, join } from "node:path"
import { mkdir, rename } from "node:fs/promises"
import type { Editor } from "../../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import type { BufferModel } from "../../src/kernel/buffer"
import { defineMode } from "../../src/modes/mode"
import { Keymap } from "../../src/kernel/keymap"
import {
  diredEntryLines,
  diredFontLock,
  refreshDiredBuffer,
  HEADER_LINES,
  NAME_OFFSET,
  type DiredEntry,
} from "../../src/modes/dired"
import { defcustom, getCustom } from "../../src/runtime/custom"

const OLD_CONTENT = "wdired-old-content"
const OLD_POINT = "wdired-old-point"
const MARKERS = "wdired-markers"
const PREV_ON_CHANGE = "wdired-prev-on-change"

/** Tracks one original dired entry through buffer edits. `offset` points at the
 *  filename column; -1 means the line was deleted (or could not be relocated)
 *  and the entry will be left untouched at commit. */
type Marker = { offset: number; entry: DiredEntry; prefix: string }

/** Snapshot a marker per entry line so commit diffs each line against the entry
 *  that was originally there — never against "the Nth original". */
function buildMarkers(text: string, entries: DiredEntry[]): Marker[] {
  const markers: Marker[] = []
  let offset = 0
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const entry = entries[i - HEADER_LINES]
    if (entry && lines[i]!.length >= NAME_OFFSET) {
      markers.push({ offset: offset + NAME_OFFSET, entry, prefix: lines[i]!.slice(0, NAME_OFFSET) })
    }
    offset += lines[i]!.length + 1
  }
  return markers
}

/** Shift markers across a splice. Markers caught strictly inside the replaced
 *  range are relocated by line prefix when the replacement still contains a
 *  unique match (covers whole-buffer setText), otherwise dropped — a dropped
 *  marker means "leave that file alone", which is the safe failure mode. */
function adjustMarkers(markers: Marker[], start: number, end: number, text: string): void {
  const delta = text.length - (end - start)
  for (const m of markers) {
    if (m.offset < 0 || m.offset <= start) continue
    if (m.offset >= end) { m.offset += delta; continue }
    m.offset = relocateByPrefix(text, m.prefix, start)
  }
  // Two markers landing on the same offset means we can't tell whose line it is.
  const seen = new Map<number, Marker>()
  for (const m of markers) {
    if (m.offset < 0) continue
    const prev = seen.get(m.offset)
    if (prev) { prev.offset = -1; m.offset = -1 } else seen.set(m.offset, m)
  }
}

function relocateByPrefix(text: string, prefix: string, base: number): number {
  let found = -1
  let pos = 0
  for (const line of text.split("\n")) {
    if (line.startsWith(prefix)) {
      if (found >= 0) return -1
      found = base + pos + prefix.length
    }
    pos += line.length + 1
  }
  return found
}

function nameAt(text: string, offset: number): string {
  const nl = text.indexOf("\n", offset)
  const name = text.slice(offset, nl < 0 ? text.length : nl)
  return name.endsWith("/") ? name.slice(0, -1) : name
}

function lineStart(text: string, offset: number): number {
  const nl = text.lastIndexOf("\n", offset - 1)
  return nl < 0 ? 0 : nl + 1
}

/** Count entry-shaped lines in the current buffer that no marker claims. */
function orphanLines(text: string, claimed: Set<number>): number {
  let n = 0
  let offset = 0
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    if (i >= HEADER_LINES && lines[i]!.length >= NAME_OFFSET && !claimed.has(offset)) n++
    offset += lines[i]!.length + 1
  }
  return n
}

function changeToDired(buffer: BufferModel): void {
  buffer.mode = "dired"
  buffer.readOnly = true
  buffer.dirty = false
  if (buffer.locals.has(PREV_ON_CHANGE)) {
    buffer.onTextChange = buffer.locals.get(PREV_ON_CHANGE) as BufferModel["onTextChange"]
  }
  buffer.locals.delete(OLD_CONTENT)
  buffer.locals.delete(OLD_POINT)
  buffer.locals.delete(MARKERS)
  buffer.locals.delete(PREV_ON_CHANGE)
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  defcustom("wdired-create-parent-directories", "boolean", true,
    "If non-nil, create parent directories of destination files when renaming.")

  const keymap = new Keymap("wdired-map")
  keymap.bind("C-c C-c", "wdired-finish-edit")
  keymap.bind("C-x C-s", "wdired-finish-edit")
  keymap.bind("C-c C-k", "wdired-abort-changes")
  keymap.bind("C-c escape", "wdired-abort-changes")
  keymap.bind("C-x C-q", "wdired-exit")
  defineMode({ name: "wdired", parent: "text", keymap, fontLock: diredFontLock })

  editor.command("wdired-change-to-wdired-mode", ({ editor, buffer }) => {
    if (buffer.mode !== "dired") {
      editor.message("Not a Dired buffer")
      return
    }
    const entries = [...(diredEntryLines.get(buffer) ?? [])]
    const markers = buildMarkers(buffer.text, entries)
    buffer.locals.set(OLD_CONTENT, buffer.text)
    buffer.locals.set(OLD_POINT, buffer.point)
    buffer.locals.set(MARKERS, markers)
    buffer.locals.set(PREV_ON_CHANGE, buffer.onTextChange)
    const prev = buffer.onTextChange
    buffer.onTextChange = ev => {
      // Columns [0, NAME_OFFSET) are conceptually read-only. We can't veto the
      // splice, so warn — and if the edit stays on one line, pin the marker to
      // the edit start so finish-edit still reads whatever is left as the name.
      const sameLine = !ev.text.includes("\n") && buffer.text.lastIndexOf("\n", ev.end - 1) < ev.start
      for (const m of markers) {
        if (m.offset < 0) continue
        const ls = lineStart(buffer.text, m.offset)
        if (ev.start >= ls && ev.start < m.offset) {
          editor.message("Read-only: edit the filename column only")
          if (sameLine && m.offset < ev.end) m.offset = ev.start
          break
        }
      }
      adjustMarkers(markers, ev.start, ev.end, ev.text)
      prev?.(ev)
    }
    buffer.mode = "wdired"
    buffer.readOnly = false
    buffer.dirty = false
    editor.message("Press C-c C-c when finished or C-c C-k to abort changes")
  }, "Put a Dired buffer in Writable Dired (WDired) mode.")

  editor.command("wdired-finish-edit", async ({ editor, buffer }) => {
    if (buffer.mode !== "wdired") {
      editor.message("Not a WDired buffer")
      return
    }
    const markers = (buffer.locals.get(MARKERS) ?? []) as Marker[]
    const claimed = new Set<number>()
    let renamed = 0
    let errors = 0
    for (const m of markers) {
      if (m.offset < 0) continue
      claimed.add(lineStart(buffer.text, m.offset))
      if (m.entry.name === ".." || m.entry.name === ".") continue
      const newName = nameAt(buffer.text, m.offset)
      if (newName === "" || newName === m.entry.name) continue
      const dest = newName.startsWith("/") ? newName : join(dirname(m.entry.path), newName)
      try {
        if (getCustom<boolean>("wdired-create-parent-directories")) {
          await mkdir(dirname(dest), { recursive: true })
        }
        await rename(m.entry.path, dest)
        renamed++
      } catch (err) {
        errors++
        editor.message(`Rename ${m.entry.name} → ${newName} failed: ${(err as Error).message}`)
      }
    }
    const ignored = orphanLines(buffer.text, claimed)
    changeToDired(buffer)
    await refreshDiredBuffer(buffer)
    await editor.changed("wdired-finish")
    const tail = ignored ? `; ${ignored} line(s) ignored (no original entry)` : ""
    if (errors) editor.message(`Renamed ${renamed} file(s), ${errors} error(s)${tail}`)
    else if (renamed || ignored) editor.message(`Renamed ${renamed} file(s)${tail}`)
    else editor.message("(No changes to be performed)")
  }, "Actually rename files based on your editing in the Dired buffer.")

  editor.command("wdired-abort-changes", async ({ editor, buffer }) => {
    if (buffer.mode !== "wdired") {
      editor.message("Not a WDired buffer")
      return
    }
    const oldContent = buffer.locals.get(OLD_CONTENT) as string | undefined
    const oldPoint = buffer.locals.get(OLD_POINT) as number | undefined
    if (oldContent != null) buffer.setText(oldContent, false)
    if (oldPoint != null) buffer.point = oldPoint
    changeToDired(buffer)
    await editor.changed("wdired-abort")
    editor.message("Changes aborted")
  }, "Abort changes and return to Dired mode.")

  editor.command("wdired-exit", async ({ editor, buffer }) => {
    if (buffer.mode !== "wdired") {
      editor.message("Not a WDired buffer")
      return
    }
    if (buffer.dirty) {
      await editor.run("wdired-finish-edit")
    } else {
      changeToDired(buffer)
      await editor.changed("wdired-exit")
      editor.message("(No changes need to be saved)")
    }
  }, "Exit wdired and return to Dired mode. Saves if the buffer was modified.")

  editor.defineKey("dired-map", "C-x C-q", "wdired-change-to-wdired-mode")
}
