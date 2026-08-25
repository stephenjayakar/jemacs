import type { BufferModel } from "../../src/kernel/buffer"
import type { Editor } from "../../src/kernel/editor"
import { Keymap } from "../../src/kernel/keymap"
import { defineMode } from "../../src/modes/mode"
import type { FaceName, TextSpan } from "../../src/modes/mode"
import { defvar } from "../../src/runtime/custom"
import { defface } from "../../src/runtime/faces"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"

export const HI_LOCK_PATTERNS_LOCAL = "hi-lock-patterns"
export const HI_YELLOW_FACE = "hi-yellow" as FaceName
export const HI_PINK_FACE = "hi-pink" as FaceName
export const HI_GREEN_FACE = "hi-green" as FaceName
export const HI_BLUE_FACE = "hi-blue" as FaceName

const HI_LOCK_FACES = [
  HI_YELLOW_FACE,
  HI_PINK_FACE,
  HI_GREEN_FACE,
  HI_BLUE_FACE,
]

type HiLockPattern = {
  regexp: string
  face: FaceName
  line: boolean
}

function hiLockPatterns(buffer: BufferModel): HiLockPattern[] {
  let patterns = buffer.locals.get(HI_LOCK_PATTERNS_LOCAL) as HiLockPattern[] | undefined
  if (!patterns) {
    patterns = []
    buffer.locals.set(HI_LOCK_PATTERNS_LOCAL, patterns)
  }
  return patterns
}

export function activeHiLockPatterns(buffer: BufferModel): HiLockPattern[] {
  return [...hiLockPatterns(buffer)]
}

function compileRegexp(pattern: string): RegExp {
  return new RegExp(pattern, "gm")
}

function validateRegexp(editor: Editor, pattern: string): boolean {
  try {
    compileRegexp(pattern)
    return true
  } catch (err) {
    editor.message((err as Error).message)
    return false
  }
}

function addPattern(buffer: BufferModel, pattern: HiLockPattern): void {
  const patterns = hiLockPatterns(buffer)
  const existing = patterns.findIndex(entry => entry.regexp === pattern.regexp && entry.line === pattern.line)
  if (existing >= 0) patterns[existing] = pattern
  else patterns.push(pattern)
}

function removePattern(buffer: BufferModel, regexp: string | null): number {
  const patterns = hiLockPatterns(buffer)
  if (regexp == null || regexp === "") {
    const count = patterns.length
    patterns.length = 0
    return count
  }
  let removed = 0
  for (let i = patterns.length - 1; i >= 0; i--) {
    if (patterns[i]!.regexp !== regexp) continue
    patterns.splice(i, 1)
    removed++
  }
  return removed
}

function uniquePatternNames(buffer: BufferModel): string[] {
  return [...new Set(hiLockPatterns(buffer).map(pattern => pattern.regexp))].sort()
}

function regexpSpans(text: string, pattern: HiLockPattern): TextSpan[] {
  const re = compileRegexp(pattern.regexp)
  const spans: TextSpan[] = []
  for (;;) {
    const match = re.exec(text)
    if (!match) break
    const start = match.index
    const end = start + match[0].length
    if (end > start) spans.push({ start, end, face: pattern.face })
    if (end === start) re.lastIndex = start + 1
  }
  return spans
}

function lineSpans(buffer: BufferModel, pattern: HiLockPattern): TextSpan[] {
  const re = compileRegexp(pattern.regexp)
  const spans: TextSpan[] = []
  for (let line = 0; line < buffer.lineCount; line++) {
    const [start, end] = buffer.lineBounds(line)
    const text = buffer.text.slice(start, end)
    re.lastIndex = 0
    if (!re.test(text)) continue
    if (end > start) spans.push({ start, end, face: pattern.face })
  }
  return spans
}

export function hiLockSpans(buffer: BufferModel, editor: Editor): TextSpan[] {
  if (!editor.isMinorModeEnabled("hi-lock-mode", buffer)) return []
  const spans: TextSpan[] = []
  for (const pattern of hiLockPatterns(buffer)) {
    try {
      spans.push(...(pattern.line ? lineSpans(buffer, pattern) : regexpSpans(buffer.text, pattern)))
    } catch {
      // Invalid regexps are rejected on entry; keep rendering resilient if state
      // was restored or edited by hand.
    }
  }
  return spans.sort((a, b) => a.start - b.start || a.end - b.end || String(a.face).localeCompare(String(b.face)))
}

async function readRegexp(editor: Editor, prompt: string, args: string[]): Promise<string | null> {
  const regexp = args[0] ?? await editor.prompt(prompt, "", "hi-lock-regexp")
  if (!regexp) return null
  return regexp
}

async function readFace(editor: Editor, args: string[]): Promise<FaceName | null> {
  const face = args[1] ?? await editor.completingRead("Highlight using face: ", {
    collection: HI_LOCK_FACES,
    history: "hi-lock-face",
    initialValue: HI_LOCK_FACES[0],
  })
  if (!face) return null
  return face as FaceName
}

async function highlight(editor: Editor, buffer: BufferModel, args: string[], line: boolean): Promise<void> {
  const regexp = await readRegexp(editor, line ? "Highlight lines matching regexp: " : "Highlight regexp: ", args)
  if (!regexp || !validateRegexp(editor, regexp)) return
  const face = await readFace(editor, args)
  if (!face) return
  addPattern(buffer, { regexp, face, line })
  editor.enableMinorMode("hi-lock-mode", { buffer })
  editor.message(`Highlighting ${line ? "lines matching " : ""}${regexp}`)
}

function toggleBufferMinorMode(editor: Editor, buffer: BufferModel, mode: string, prefixArgument?: number | null): void {
  if (prefixArgument != null && prefixArgument > 0) editor.enableMinorMode(mode, { buffer })
  else if (prefixArgument != null && prefixArgument <= 0) editor.disableMinorMode(mode, { buffer })
  else editor.toggleMinorMode(mode, { buffer })
}

function installMessagesBufferMode(editor: Editor): void {
  const keymap = new Keymap("messages-buffer-mode-map")
  keymap.bind("q", "quit-window")
  keymap.bind("C-c C-c", "messages-buffer-noop")
  defineMode({
    name: "messages-buffer-mode",
    parent: "text",
    keymap,
    onEnter: buffer => { buffer.readOnly = true },
  })

  for (const buffer of editor.buffers.values()) {
    if (buffer.kind !== "messages") continue
    editor.enterMode(buffer, "messages-buffer-mode")
  }
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  defface("hi-yellow", { bg: "#5a4f00", fg: "#fff6bf" }, "Face for hi-lock yellow highlights.", "hi-lock")
  defface("hi-pink", { bg: "#5a2545", fg: "#ffd6eb" }, "Face for hi-lock pink highlights.", "hi-lock")
  defface("hi-green", { bg: "#245a32", fg: "#d7ffd9" }, "Face for hi-lock green highlights.", "hi-lock")
  defface("hi-blue", { bg: "#244f7a", fg: "#d8edff" }, "Face for hi-lock blue highlights.", "hi-lock")

  const overlayEditors = defvar("hi-lock--overlay-editors", new WeakSet<Editor>(),
    "Editors that have registered the hi-lock overlay source.", "hi-lock").value
  if (!overlayEditors.has(editor)) {
    editor.addOverlaySource(buffer => hiLockSpans(buffer, editor))
    overlayEditors.add(editor)
  }

  ctx.minorMode({ name: "hi-lock-mode", lighter: " Hi" })

  installMessagesBufferMode(editor)

  ctx.command("hi-lock-mode", ({ editor, buffer, prefixArgument }) => {
    toggleBufferMinorMode(editor, buffer, "hi-lock-mode", prefixArgument)
  }, "Toggle Hi Lock mode in the current buffer.")

  ctx.command("highlight-regexp", async ({ editor, buffer, args }) => {
    await highlight(editor, buffer, args, false)
  }, "Highlight text matching a regexp in the current buffer.")

  ctx.command("highlight-lines-matching-regexp", async ({ editor, buffer, args }) => {
    await highlight(editor, buffer, args, true)
  }, "Highlight lines matching a regexp in the current buffer.")

  ctx.command("unhighlight-regexp", async ({ editor, buffer, args }) => {
    const collection = uniquePatternNames(buffer)
    const regexp = args[0] ?? await editor.completingRead("Unhighlight regexp (empty for all): ", {
      collection,
      history: "hi-lock-regexp",
      initialValue: "",
    })
    if (regexp == null) return
    const removed = removePattern(buffer, regexp)
    editor.message(removed ? "Removed highlight" : "No matching highlight")
    await editor.changed("hi-lock-unhighlight")
  }, "Remove a regexp highlight from the current buffer; empty input removes all.")

  ctx.command("messages-buffer-noop", () => {}, "Do nothing in `messages-buffer-mode'.")

  ctx.key("global-map", "M-s h r", "highlight-regexp")
  ctx.key("global-map", "M-s h l", "highlight-lines-matching-regexp")
  ctx.key("global-map", "M-s h u", "unhighlight-regexp")
}
