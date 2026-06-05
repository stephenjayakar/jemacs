import type { Editor } from "../../src/kernel/editor"
import type { BufferModel } from "../../src/kernel/buffer"
import type { FaceName, TextSpan } from "../../src/modes/mode"
import { defineMinorMode } from "../../src/modes/minor-mode"
import { addHook } from "../../src/kernel/hooks"
import { defcustom, getCustom } from "../../src/runtime/custom"

export const SMERGE_OVERLAYS_LOCAL = "smerge-overlays"

/** FaceName is a closed union; map smerge faces onto the closest existing ones. */
export const SMERGE_FACES: Record<"markers" | "upper" | "base" | "lower", FaceName> = {
  markers: "comment",
  upper: "error",
  base: "constant",
  lower: "string",
}

/** Mirrors the `smerge-match-conflict` match-data layout (groups 0..3). */
export type SmergeMatch = {
  start: number
  end: number
  upperStart: number
  upperEnd: number
  baseStart: number | null
  baseEnd: number | null
  lowerStart: number
  lowerEnd: number
}

// Emacs: smerge-begin-re / -end-re / -base-re / -lower-re.
const BEGIN_RE = /^<<<<<<< .*\n/gm
const END_RE = /^>>>>>>> .*\n?/gm
const BASE_RE = /^\|{7} .*\n/gm
const LOWER_RE = /^=======\n/gm

function lastMatchBefore(re: RegExp, text: string, limit: number, from = 0): RegExpExecArray | null {
  re.lastIndex = from
  let last: RegExpExecArray | null = null
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    if (m.index >= limit) break
    last = m
  }
  return last
}

function firstMatchAfter(re: RegExp, text: string, from: number, limit?: number): RegExpExecArray | null {
  re.lastIndex = from
  const m = re.exec(text)
  if (!m) return null
  if (limit != null && m.index >= limit) return null
  return m
}

/** Parse the conflict whose begin-marker line starts at `beginIndex`. */
function parseConflict(text: string, beginIndex: number, beginLen: number): SmergeMatch | null {
  const start = beginIndex
  const upperStart = beginIndex + beginLen

  const endMatch = firstMatchAfter(END_RE, text, upperStart)
  if (!endMatch) return null
  const lowerEnd = endMatch.index
  const end = endMatch.index + endMatch[0].length

  // A second begin marker before `end` means a nested conflict — don't pretend
  // to understand it (matches Emacs's "There is a nested conflict" branch).
  if (firstMatchAfter(BEGIN_RE, text, upperStart, end)) return null

  const lowerMatch = lastMatchBefore(LOWER_RE, text, lowerEnd, upperStart)
  if (!lowerMatch) return null
  let upperEnd = lowerMatch.index
  const lowerStart = lowerMatch.index + lowerMatch[0].length

  let baseStart: number | null = null
  let baseEnd: number | null = null
  const baseMatch = lastMatchBefore(BASE_RE, text, upperEnd, upperStart)
  if (baseMatch) {
    baseEnd = upperEnd
    upperEnd = baseMatch.index
    baseStart = baseMatch.index + baseMatch[0].length
  }

  return { start, end, upperStart, upperEnd, baseStart, baseEnd, lowerStart, lowerEnd }
}

/** Locate the conflict enclosing `point`, or null if point is not inside one. */
export function smergeMatchConflict(text: string, point: number): SmergeMatch | null {
  // Emacs: (forward-line 1) (re-search-backward smerge-begin-re).
  const nl = text.indexOf("\n", point)
  const searchFrom = nl === -1 ? text.length : nl + 1
  const begin = lastMatchBefore(BEGIN_RE, text, searchFrom)
  if (!begin) return null
  const conflict = parseConflict(text, begin.index, begin[0].length)
  if (!conflict) return null
  if (point < conflict.start || point >= conflict.end) return null
  return conflict
}

/** All well-formed conflicts in `text`, ordered by position. */
export function smergeFindConflicts(text: string): SmergeMatch[] {
  const out: SmergeMatch[] = []
  BEGIN_RE.lastIndex = 0
  for (let m: RegExpExecArray | null; (m = BEGIN_RE.exec(text)); ) {
    const conflict = parseConflict(text, m.index, m[0].length)
    if (conflict) {
      out.push(conflict)
      BEGIN_RE.lastIndex = conflict.end
    }
  }
  return out
}

export function smergeSpans(buffer: BufferModel): TextSpan[] {
  return (buffer.locals.get(SMERGE_OVERLAYS_LOCAL) as TextSpan[] | undefined) ?? []
}

function computeSpans(text: string): TextSpan[] {
  const spans: TextSpan[] = []
  for (const c of smergeFindConflicts(text)) {
    spans.push({ start: c.start, end: c.upperStart, face: SMERGE_FACES.markers })
    if (c.upperStart < c.upperEnd) spans.push({ start: c.upperStart, end: c.upperEnd, face: SMERGE_FACES.upper })
    if (c.baseStart != null && c.baseEnd != null) {
      spans.push({ start: c.upperEnd, end: c.baseStart, face: SMERGE_FACES.markers })
      if (c.baseStart < c.baseEnd) spans.push({ start: c.baseStart, end: c.baseEnd, face: SMERGE_FACES.base })
      spans.push({ start: c.baseEnd, end: c.lowerStart, face: SMERGE_FACES.markers })
    } else {
      spans.push({ start: c.upperEnd, end: c.lowerStart, face: SMERGE_FACES.markers })
    }
    if (c.lowerStart < c.lowerEnd) spans.push({ start: c.lowerStart, end: c.lowerEnd, face: SMERGE_FACES.lower })
    spans.push({ start: c.lowerEnd, end: c.end, face: SMERGE_FACES.markers })
  }
  return spans
}

function refresh(editor: Editor, buffer: BufferModel): void {
  if (!editor.isMinorModeEnabled("smerge-mode", buffer)) {
    buffer.locals.delete(SMERGE_OVERLAYS_LOCAL)
    return
  }
  buffer.locals.set(SMERGE_OVERLAYS_LOCAL, computeSpans(buffer.text))
}

function autoLeave(editor: Editor, buffer: BufferModel): void {
  if (!(getCustom<boolean>("smerge-auto-leave") ?? true)) return
  BEGIN_RE.lastIndex = 0
  if (!BEGIN_RE.test(buffer.text)) editor.disableMinorMode("smerge-mode", { buffer })
}

function keepN(editor: Editor, buffer: BufferModel, which: 1 | 2 | 3): void {
  const c = smergeMatchConflict(buffer.text, buffer.point)
  if (!c) {
    editor.message("Point not in conflict region")
    return
  }
  let kept: string
  if (which === 1) kept = buffer.text.slice(c.upperStart, c.upperEnd)
  else if (which === 3) kept = buffer.text.slice(c.lowerStart, c.lowerEnd)
  else {
    if (c.baseStart == null || c.baseEnd == null) {
      editor.message("No `base'")
      return
    }
    kept = buffer.text.slice(c.baseStart, c.baseEnd)
  }
  buffer.replaceRange(c.start, c.end, kept)
  buffer.point = c.start
  refresh(editor, buffer)
  autoLeave(editor, buffer)
}

function keepAll(editor: Editor, buffer: BufferModel): void {
  const c = smergeMatchConflict(buffer.text, buffer.point)
  if (!c) {
    editor.message("Point not in conflict region")
    return
  }
  const upper = buffer.text.slice(c.upperStart, c.upperEnd)
  const base = c.baseStart != null && c.baseEnd != null ? buffer.text.slice(c.baseStart, c.baseEnd) : ""
  const lower = buffer.text.slice(c.lowerStart, c.lowerEnd)
  buffer.replaceRange(c.start, c.end, upper + base + lower)
  buffer.point = c.start
  refresh(editor, buffer)
  autoLeave(editor, buffer)
}

function gotoConflict(editor: Editor, buffer: BufferModel, dir: 1 | -1): void {
  const conflicts = smergeFindConflicts(buffer.text)
  const target = dir === 1
    ? conflicts.find(c => c.start > buffer.point)
    : [...conflicts].reverse().find(c => c.start < buffer.point)
  if (!target) {
    editor.message(dir === 1 ? "No next conflict" : "No previous conflict")
    return
  }
  buffer.point = target.start
}

export function install(editor: Editor): void {
  defcustom("smerge-auto-leave", "boolean", true,
    "Non-nil means to leave `smerge-mode' when the last conflict is resolved.")

  defineMinorMode({
    name: "smerge-mode",
    lighter: " SMerge",
    onEnable: (ed, buf) => { if (buf) refresh(ed, buf) },
    onDisable: (_ed, buf) => { buf?.locals.delete(SMERGE_OVERLAYS_LOCAL) },
  })

  editor.addOverlaySource(smergeSpans)

  editor.command("smerge-mode", ({ editor, buffer, prefixArgument }) => {
    if (prefixArgument != null && prefixArgument > 0) editor.enableMinorMode("smerge-mode", { buffer })
    else if (prefixArgument != null && prefixArgument <= 0) editor.disableMinorMode("smerge-mode", { buffer })
    else editor.toggleMinorMode("smerge-mode", { buffer })
  }, "Minor mode to simplify editing output from the diff3 program.")

  editor.command("smerge-next", ({ editor, buffer }) => gotoConflict(editor, buffer, 1),
    "Go to the next conflict.")
  editor.command("smerge-prev", ({ editor, buffer }) => gotoConflict(editor, buffer, -1),
    "Go to the previous conflict.")

  editor.command("smerge-keep-upper", ({ editor, buffer }) => keepN(editor, buffer, 1),
    "Keep the upper version of a merge conflict.")
  editor.command("smerge-keep-lower", ({ editor, buffer }) => keepN(editor, buffer, 3),
    "Keep the lower version of a merge conflict.")
  editor.command("smerge-keep-base", ({ editor, buffer }) => keepN(editor, buffer, 2),
    "Revert to the base version.")
  editor.command("smerge-keep-all", ({ editor, buffer }) => keepAll(editor, buffer),
    "Concatenate all versions.")
  // Obsolete-since-26.1 names that fingers still type.
  editor.command("smerge-keep-mine", ({ editor, buffer }) => keepN(editor, buffer, 1),
    "Keep the upper version of a merge conflict.")
  editor.command("smerge-keep-other", ({ editor, buffer }) => keepN(editor, buffer, 3),
    "Keep the lower version of a merge conflict.")

  // Emacs: smerge-command-prefix is "\C-c^".
  for (const [k, cmd] of [
    ["n", "smerge-next"], ["p", "smerge-prev"],
    ["a", "smerge-keep-all"], ["b", "smerge-keep-base"],
    ["u", "smerge-keep-upper"], ["m", "smerge-keep-upper"],
    ["l", "smerge-keep-lower"], ["o", "smerge-keep-lower"],
  ] as const) {
    editor.defineKey("smerge-mode-map", `C-c ^ ${k}`, cmd)
  }

  addHook("find-file-hook", ({ editor, buffer }) => {
    BEGIN_RE.lastIndex = 0
    if (BEGIN_RE.test(buffer.text)) editor.enableMinorMode("smerge-mode", { buffer })
  })

  editor.events.on("changed", () => {
    const buffer = editor.currentBuffer
    if (editor.isMinorModeEnabled("smerge-mode", buffer)) refresh(editor, buffer)
  })
}
