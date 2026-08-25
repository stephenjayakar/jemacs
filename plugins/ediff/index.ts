import { homedir } from "node:os"
import type { BufferModel } from "../../src/kernel/buffer"
import type { Editor } from "../../src/kernel/editor"
import { Keymap } from "../../src/kernel/keymap"
import { createLeafWindow, mapWindowLeaves, type WindowId } from "../../src/kernel/window"
import { defineMode, type FaceName, type TextSpan } from "../../src/modes/mode"
import { defvar } from "../../src/runtime/custom"
import { defface } from "../../src/runtime/faces"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"

export const EDIFF_SESSION_LOCAL = "ediff-session"
export const EDIFF_OVERLAYS_LOCAL = "ediff-overlays"
export const EDIFF_CONTROL_BUFFER_NAME = "*Ediff Control*"
export const EDIFF_CURRENT_A_FACE = "ediff-current-difference-a" as FaceName
export const EDIFF_CURRENT_B_FACE = "ediff-current-difference-b" as FaceName

type WindowConfiguration = ReturnType<Editor["currentWindowConfiguration"]>

export type EdiffRegion = {
  aStartLine: number
  aEndLine: number
  aStart: number
  aEnd: number
  bStartLine: number
  bEndLine: number
  bStart: number
  bEnd: number
}

export type EdiffSession = {
  aBufferId: string
  bBufferId: string
  controlBufferId: string
  aWindowId: WindowId
  bWindowId: WindowId
  controlWindowId: WindowId
  diffs: EdiffRegion[]
  currentIndex: number
  previousWindowConfiguration: WindowConfiguration
}

type LineRecord = {
  text: string
  start: number
  end: number
}

function directoryInitialValue(directory: string): string {
  return directory.endsWith("/") ? directory : `${directory}/`
}

function substituteInFileName(input: string): string {
  const restart = Math.max(input.lastIndexOf("//"), input.lastIndexOf("/~"))
  const stripped = restart >= 0 ? input.slice(restart + 1) : input
  if (stripped === "~" || stripped.startsWith("~/")) return homedir() + stripped.slice(1)
  return stripped
}

function resolveBufferName(editor: Editor, name: string): BufferModel | null {
  return editor.buffers.get(name)
    ?? [...editor.buffers.values()].find(b => b.name === name || editor.bufferDisplayName(b) === name)
    ?? null
}

function lineRecords(text: string): LineRecord[] {
  if (text === "") return []
  const out: LineRecord[] = []
  let start = 0
  while (start < text.length) {
    const newline = text.indexOf("\n", start)
    const end = newline === -1 ? text.length : newline + 1
    out.push({ text: text.slice(start, end), start, end })
    start = end
  }
  return out
}

function lineStart(lines: LineRecord[], index: number, textLength: number): number {
  return lines[index]?.start ?? textLength
}

function lineEnd(lines: LineRecord[], startLine: number, endLine: number, textLength: number): number {
  if (endLine <= startLine) return lineStart(lines, startLine, textLength)
  return lines[endLine - 1]?.end ?? textLength
}

function makeRegion(
  aLines: LineRecord[],
  bLines: LineRecord[],
  aTextLength: number,
  bTextLength: number,
  aStartLine: number,
  aEndLine: number,
  bStartLine: number,
  bEndLine: number,
): EdiffRegion {
  return {
    aStartLine,
    aEndLine,
    aStart: lineStart(aLines, aStartLine, aTextLength),
    aEnd: lineEnd(aLines, aStartLine, aEndLine, aTextLength),
    bStartLine,
    bEndLine,
    bStart: lineStart(bLines, bStartLine, bTextLength),
    bEnd: lineEnd(bLines, bStartLine, bEndLine, bTextLength),
  }
}

export function ediffLineDiffs(aText: string, bText: string): EdiffRegion[] {
  if (aText === bText) return []
  const a = lineRecords(aText)
  const b = lineRecords(bText)
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i]!.text === b[j]!.text
        ? 1 + dp[i + 1]![j + 1]!
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }

  const regions: EdiffRegion[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i]!.text === b[j]!.text) {
      i++
      j++
      continue
    }

    const aStartLine = i
    const bStartLine = j
    while (
      i < n
      && (j >= m || a[i]!.text !== b[j]!.text)
      && (j >= m || dp[i + 1]![j]! >= dp[i]![j + 1]!)
    ) {
      i++
    }
    while (j < m && (i >= n || a[i]!.text !== b[j]!.text)) {
      j++
    }
    regions.push(makeRegion(a, b, aText.length, bText.length, aStartLine, i, bStartLine, j))
  }

  return regions
}

export function ediffSpans(buffer: BufferModel): TextSpan[] {
  return (buffer.locals.get(EDIFF_OVERLAYS_LOCAL) as TextSpan[] | undefined) ?? []
}

export function ediffSession(buffer: BufferModel): EdiffSession | null {
  return (buffer.locals.get(EDIFF_SESSION_LOCAL) as EdiffSession | undefined) ?? null
}

function sessionBuffers(editor: Editor, session: EdiffSession): { a: BufferModel; b: BufferModel; control: BufferModel } | null {
  const a = editor.buffers.get(session.aBufferId)
  const b = editor.buffers.get(session.bBufferId)
  const control = editor.buffers.get(session.controlBufferId)
  if (!a || !b || !control) return null
  return { a, b, control }
}

function currentSession(editor: Editor, buffer: BufferModel): EdiffSession | null {
  const session = ediffSession(buffer)
  if (session) return session
  editor.message("Not in an Ediff control buffer")
  return null
}

function replaceReadOnly(buffer: BufferModel, text: string): void {
  const wasReadOnly = buffer.readOnly
  buffer.readOnly = false
  buffer.setText(text, false, false)
  buffer.readOnly = wasReadOnly
}

function renderControl(editor: Editor, session: EdiffSession): void {
  const buffers = sessionBuffers(editor, session)
  if (!buffers) return
  const { a, b, control } = buffers
  const count = session.diffs.length
  const current = session.currentIndex >= 0 && session.currentIndex < count
    ? `${session.currentIndex + 1}/${count}`
    : count ? `0/${count}` : "0/0"
  const lines = [
    `Ediff: ${editor.bufferDisplayName(a)} <-> ${editor.bufferDisplayName(b)}`,
    `Difference: ${current}`,
    "",
    "n next    p previous    a A->B    b B->A    ! recompute    q quit",
    "",
  ]
  replaceReadOnly(control, lines.join("\n"))
  control.point = 0
  control.readOnly = true
}

function clearHighlights(editor: Editor, session: EdiffSession): void {
  const buffers = sessionBuffers(editor, session)
  if (!buffers) return
  buffers.a.locals.delete(EDIFF_OVERLAYS_LOCAL)
  buffers.b.locals.delete(EDIFF_OVERLAYS_LOCAL)
}

function regionSpan(region: EdiffRegion, side: "a" | "b"): TextSpan[] {
  const start = side === "a" ? region.aStart : region.bStart
  const end = side === "a" ? region.aEnd : region.bEnd
  if (start >= end) return []
  return [{ start, end, face: side === "a" ? EDIFF_CURRENT_A_FACE : EDIFF_CURRENT_B_FACE }]
}

function applyCurrent(editor: Editor, session: EdiffSession): void {
  const buffers = sessionBuffers(editor, session)
  if (!buffers) return
  clearHighlights(editor, session)
  const region = session.diffs[session.currentIndex]
  if (!region) {
    renderControl(editor, session)
    return
  }

  buffers.a.point = region.aStart
  buffers.b.point = region.bStart
  buffers.a.locals.set(EDIFF_OVERLAYS_LOCAL, regionSpan(region, "a"))
  buffers.b.locals.set(EDIFF_OVERLAYS_LOCAL, regionSpan(region, "b"))

  editor.mutateWindowLayout(layout => mapWindowLeaves(layout, leaf => {
    if (leaf.id === session.aWindowId) {
      return { ...leaf, point: region.aStart, startLine: region.aStartLine }
    }
    if (leaf.id === session.bWindowId) {
      return { ...leaf, point: region.bStart, startLine: region.bStartLine }
    }
    return leaf
  }), "ediff-goto-difference")
  renderControl(editor, session)
}

function recomputeSession(editor: Editor, session: EdiffSession, keepCurrent = true): void {
  const buffers = sessionBuffers(editor, session)
  if (!buffers) return
  session.diffs = ediffLineDiffs(buffers.a.text, buffers.b.text)
  if (!session.diffs.length) {
    session.currentIndex = -1
  } else if (!keepCurrent || session.currentIndex < 0) {
    session.currentIndex = -1
  } else {
    session.currentIndex = Math.min(session.currentIndex, session.diffs.length - 1)
  }
  if (session.currentIndex >= 0) applyCurrent(editor, session)
  else {
    clearHighlights(editor, session)
    renderControl(editor, session)
  }
}

function gotoDifference(editor: Editor, session: EdiffSession, direction: 1 | -1): void {
  if (!session.diffs.length) {
    editor.message("No differences")
    return
  }
  const next = direction === 1
    ? session.currentIndex < 0 ? 0 : session.currentIndex + 1
    : session.currentIndex < 0 ? -1 : session.currentIndex - 1
  if (next < 0 || next >= session.diffs.length) {
    editor.message(direction === 1 ? "No next difference" : "No previous difference")
    return
  }
  session.currentIndex = next
  applyCurrent(editor, session)
  editor.message(`Difference ${session.currentIndex + 1} of ${session.diffs.length}`)
}

function copyCurrent(editor: Editor, session: EdiffSession, direction: "a-to-b" | "b-to-a"): void {
  const buffers = sessionBuffers(editor, session)
  if (!buffers) return
  const region = session.diffs[session.currentIndex]
  if (!region) {
    editor.message("No current difference")
    return
  }

  if (direction === "a-to-b") {
    const replacement = buffers.a.text.slice(region.aStart, region.aEnd)
    buffers.b.replaceRange(region.bStart, region.bEnd, replacement)
    editor.message("Copied A to B")
  } else {
    const replacement = buffers.b.text.slice(region.bStart, region.bEnd)
    buffers.a.replaceRange(region.aStart, region.aEnd, replacement)
    editor.message("Copied B to A")
  }
  recomputeSession(editor, session, true)
}

function cleanupSession(
  editor: Editor,
  session: EdiffSession,
  options: { restoreWindowConfiguration: boolean; killControl: boolean },
): void {
  const buffers = sessionBuffers(editor, session)
  if (buffers) {
    clearHighlights(editor, session)
    buffers.control.locals.delete(EDIFF_SESSION_LOCAL)
  }
  if (options.restoreWindowConfiguration) editor.restoreWindowConfiguration(session.previousWindowConfiguration)
  if (options.killControl) editor.killBuffer(session.controlBufferId)
}

function showSessionWindows(editor: Editor, session: EdiffSession): void {
  const buffers = sessionBuffers(editor, session)
  if (!buffers) return
  const aLeaf = createLeafWindow(buffers.a.id, buffers.a.point)
  const bLeaf = createLeafWindow(buffers.b.id, buffers.b.point)
  const controlLeaf = createLeafWindow(buffers.control.id, buffers.control.point)
  controlLeaf.dedicated = true
  session.aWindowId = aLeaf.id
  session.bWindowId = bLeaf.id
  session.controlWindowId = controlLeaf.id
  editor.mutateWindowLayout(() => ({
    kind: "split",
    direction: "horizontal",
    firstRatio: 0.5,
    first: aLeaf,
    second: {
      kind: "split",
      direction: "vertical",
      firstRatio: 0.78,
      first: bLeaf,
      second: controlLeaf,
    },
  }), "ediff-setup")
  editor.selectWindow(controlLeaf.id)
}

function startSession(
  editor: Editor,
  a: BufferModel,
  b: BufferModel,
  previousWindowConfiguration = editor.currentWindowConfiguration(),
): EdiffSession {
  const control = editor.scratch(EDIFF_CONTROL_BUFFER_NAME, "", "ediff-mode")
  const oldSession = ediffSession(control)
  if (oldSession) cleanupSession(editor, oldSession, { restoreWindowConfiguration: false, killControl: false })

  const session: EdiffSession = {
    aBufferId: a.id,
    bBufferId: b.id,
    controlBufferId: control.id,
    aWindowId: "",
    bWindowId: "",
    controlWindowId: "",
    diffs: ediffLineDiffs(a.text, b.text),
    currentIndex: -1,
    previousWindowConfiguration,
  }
  control.locals.set(EDIFF_SESSION_LOCAL, session)
  control.readOnly = true
  showSessionWindows(editor, session)
  renderControl(editor, session)
  editor.message(session.diffs.length ? `${session.diffs.length} difference${session.diffs.length === 1 ? "" : "s"}` : "No differences")
  return session
}

function bufferNameCollection(editor: Editor): string[] {
  return [...editor.buffers.values()]
    .filter(buffer => buffer.kind !== "minibuffer")
    .map(buffer => editor.bufferDisplayName(buffer))
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  defface("ediff-current-difference-a", { bg: "#5a3434", fg: "#ffe2e2" },
    "Face for the current Ediff region in buffer A.", "ediff")
  defface("ediff-current-difference-b", { bg: "#2f4f3c", fg: "#e3ffe9" },
    "Face for the current Ediff region in buffer B.", "ediff")

  const ediffMap = new Keymap("ediff-mode-map")
  ediffMap.bind("n", "ediff-next-difference")
  ediffMap.bind("p", "ediff-previous-difference")
  ediffMap.bind("a", "ediff-copy-A-to-B")
  ediffMap.bind("b", "ediff-copy-B-to-A")
  ediffMap.bind("!", "ediff-update-diffs")
  ediffMap.bind("q", "ediff-quit")
  defineMode({ name: "ediff-mode", parent: "text", keymap: ediffMap })

  const overlayEditors = defvar("ediff--overlay-editors", new WeakSet<Editor>(),
    "Editors that have registered the Ediff overlay source.", "ediff").value
  if (!overlayEditors.has(editor)) {
    editor.addOverlaySource(ediffSpans)
    overlayEditors.add(editor)
  }

  ctx.command("ediff-buffers", async ({ editor, args }) => {
    const first = args[0] ?? await editor.completingRead("Ediff buffer A: ", {
      collection: bufferNameCollection(editor),
      history: "buffer",
      initialValue: editor.bufferDisplayName(editor.currentBuffer),
    })
    if (!first) return
    const second = args[1] ?? await editor.completingRead("Ediff buffer B: ", {
      collection: bufferNameCollection(editor),
      history: "buffer",
    })
    if (!second) return
    const a = resolveBufferName(editor, first)
    const b = resolveBufferName(editor, second)
    if (!a || !b) {
      editor.message(`No such buffer: ${!a ? first : second}`)
      return
    }
    startSession(editor, a, b)
  }, "Compare two buffers using Ediff.")

  ctx.command("ediff-files", async ({ editor, args }) => {
    const previousWindowConfiguration = editor.currentWindowConfiguration()
    const first = args[0] ?? await editor.completingRead("Ediff file A: ", {
      completion: "file",
      history: "file",
      initialValue: directoryInitialValue(editor.currentBuffer.directory() ?? process.cwd()),
    })
    if (!first) return
    const second = args[1] ?? await editor.completingRead("Ediff file B: ", {
      completion: "file",
      history: "file",
      initialValue: directoryInitialValue(editor.currentBuffer.directory() ?? process.cwd()),
    })
    if (!second) return
    const a = await editor.openFile(substituteInFileName(first))
    const b = await editor.openFile(substituteInFileName(second))
    startSession(editor, a, b, previousWindowConfiguration)
  }, "Compare two files using Ediff.")

  ctx.command("ediff-next-difference", ({ editor, buffer }) => {
    const session = currentSession(editor, buffer)
    if (session) gotoDifference(editor, session, 1)
  }, "Move to the next Ediff difference.")

  ctx.command("ediff-previous-difference", ({ editor, buffer }) => {
    const session = currentSession(editor, buffer)
    if (session) gotoDifference(editor, session, -1)
  }, "Move to the previous Ediff difference.")

  ctx.command("ediff-copy-A-to-B", ({ editor, buffer }) => {
    const session = currentSession(editor, buffer)
    if (session) copyCurrent(editor, session, "a-to-b")
  }, "Copy the current Ediff difference from buffer A to buffer B.")

  ctx.command("ediff-copy-B-to-A", ({ editor, buffer }) => {
    const session = currentSession(editor, buffer)
    if (session) copyCurrent(editor, session, "b-to-a")
  }, "Copy the current Ediff difference from buffer B to buffer A.")

  ctx.command("ediff-update-diffs", ({ editor, buffer }) => {
    const session = currentSession(editor, buffer)
    if (!session) return
    recomputeSession(editor, session, true)
    editor.message(session.diffs.length ? `${session.diffs.length} difference${session.diffs.length === 1 ? "" : "s"}` : "No differences")
  }, "Recompute Ediff differences.")

  ctx.command("ediff-quit", ({ editor, buffer }) => {
    const session = currentSession(editor, buffer)
    if (!session) return
    cleanupSession(editor, session, { restoreWindowConfiguration: true, killControl: true })
    editor.message("Quit Ediff")
  }, "Quit Ediff and restore the previous window layout.")

  ctx.hook("kill-buffer-hook", ({ editor: ed, buffer }) => {
    if (ed !== editor) return
    const session = ediffSession(buffer)
    if (session) cleanupSession(editor, session, { restoreWindowConfiguration: false, killControl: false })
  })
}
