import type { Editor } from "../../src/kernel/editor"
import type { BufferModel } from "../../src/kernel/buffer"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"
import { defcustom, getCustom } from "../../src/runtime/custom"
import { defineMinorMode } from "../../src/modes/minor-mode"
import { foldDisplay, foldedLines, elementRange, lineIndexAt, FOLDED_LINES } from "./folding"
import { modeFeature } from "../../src/modes/mode"
import { defmethod } from "../../src/runtime/generic"
import { saveContextOptions } from "../../src/core/save-context"

/**
 * The loose ends of Stephen's `init.el`: the editing-behaviour tweaks and one-off
 * commands that never belonged to a package.
 *
 * Grouped into one plugin rather than a dozen single-command files because they share no
 * state and each is a few lines; the alternative is a plugin directory that is mostly
 * boilerplate.
 */

defcustom(
  "auto-save-visited-interval",
  "number",
  1,
  "Seconds between auto-saves of file-visiting buffers.",
)

defcustom<string[]>(
  "auto-save-visited-modes",
  "sexp",
  ["markdown", "gfm"],
  "Major modes eligible for auto-save-visited. Empty means every file-visiting buffer.",
)

defcustom(
  "slick-copy",
  "boolean",
  true,
  "When non-nil, `kill-ring-save`/`kill-region` with no active region act on the whole line.",
)

/** Offset of the start of the line containing `point`. */
function lineBeginningPosition(buffer: BufferModel, point = buffer.point): number {
  const text = buffer.text
  const index = text.lastIndexOf("\n", Math.max(0, point - 1))
  return index === -1 ? 0 : index + 1
}

/** Offset of the start of the *next* line, i.e. `(line-beginning-position 2)`. */
function nextLineBeginningPosition(buffer: BufferModel, point = buffer.point): number {
  const index = buffer.text.indexOf("\n", point)
  return index === -1 ? buffer.text.length : index + 1
}

/** Inclusive/exclusive bounds of the active region, or null when there is none. */
function activeRegion(buffer: BufferModel): [number, number] | null {
  if (buffer.mark == null || !buffer.markActive) return null
  if (buffer.mark === buffer.point) return null
  return [Math.min(buffer.mark, buffer.point), Math.max(buffer.mark, buffer.point)]
}

/**
 * Renumber `= N;` protobuf field tags in the region, ascending from 1.
 *
 * Operates on the region only — renumbering a whole file would silently rewrite tags of
 * released protos, which is a wire-compatibility break.
 */
export function renumberProtoFields(text: string): string {
  let counter = 0
  return text.replace(/= *\d+;/g, () => `= ${++counter};`)
}

/** Split an identifier into its lowercase component words. */
function inflectionWords(word: string): string[] {
  return word.includes("_")
    ? word.toLowerCase().split("_").filter(Boolean)
    : word.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(" ").filter(Boolean)
}

const INFLECTION_FORMS = ["snake", "camel", "pascal", "upper"] as const
type InflectionForm = (typeof INFLECTION_FORMS)[number]

function renderInflection(parts: string[], form: InflectionForm): string {
  switch (form) {
    case "snake": return parts.join("_")
    case "camel": return parts[0] + parts.slice(1).map(capitalize).join("")
    case "pascal": return parts.map(capitalize).join("")
    case "upper": return parts.map(p => p.toUpperCase()).join("_")
  }
}

function detectInflection(word: string): InflectionForm {
  const hasUnderscore = word.includes("_")
  if (hasUnderscore && word === word.toUpperCase()) return "upper"
  if (hasUnderscore) return "snake"
  return /^[A-Z]/.test(word) ? "pascal" : "camel"
}

/**
 * Cycle snake_case -> camelCase -> PascalCase -> UPPER_SNAKE -> snake_case.
 *
 * Forms whose rendering is identical to the input are skipped, so single words still
 * advance (`foo` -> `Foo` -> `FOO` -> `foo`) instead of sticking on a no-op.
 */
export function cycleInflection(word: string): string {
  const parts = inflectionWords(word)
  if (parts.length === 0) return word
  const start = INFLECTION_FORMS.indexOf(detectInflection(word))
  for (let step = 1; step <= INFLECTION_FORMS.length; step++) {
    const candidate = renderInflection(parts, INFLECTION_FORMS[(start + step) % INFLECTION_FORMS.length]!)
    if (candidate !== word) return candidate
  }
  return word
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Word characters around point, as string-inflection would delimit them. */
function symbolBounds(buffer: BufferModel): [number, number] | null {
  const text = buffer.text
  const isWord = (c: string | undefined) => c != null && /[A-Za-z0-9_]/.test(c)
  if (!isWord(text[buffer.point]) && !isWord(text[buffer.point - 1])) return null
  let start = buffer.point
  while (start > 0 && isWord(text[start - 1])) start--
  let end = buffer.point
  while (end < text.length && isWord(text[end])) end++
  return start === end ? null : [start, end]
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  // ── delete-selection-mode ───────────────────────────────────────────────
  //
  // Typing or yanking with an active region replaces it. Implemented as advice on the
  // insert commands rather than a keymap so it composes with any binding that reaches
  // `self-insert-command`.
  ctx.minorMode({
    name: "delete-selection-mode",
    lighter: "",
    global: true,
  })

  const deleteActiveRegion = ({ editor, buffer }: { editor: Editor; buffer: BufferModel }): void => {
    if (!editor.globalMinorModes.has("delete-selection-mode")) return
    const region = activeRegion(buffer)
    if (!region) return
    buffer.deleteRange(region[0], region[1])
    buffer.clearMark()
  }

  for (const command of ["self-insert-command", "yank", "newline", "newline-and-indent"]) {
    if (editor.commands.get(command)) ctx.advice(command, { before: deleteActiveRegion })
  }

  ctx.command("delete-selection-mode", ({ editor, prefixArgument }) => {
    if (prefixArgument != null && prefixArgument <= 0) editor.disableMinorMode("delete-selection-mode")
    else if (prefixArgument != null) editor.enableMinorMode("delete-selection-mode")
    else editor.toggleMinorMode("delete-selection-mode")
  }, "Toggle whether typing replaces the active region.")

  // ── slick-copy / slick-cut ──────────────────────────────────────────────
  //
  // With no region, M-w copies and C-w kills the whole line. In Emacs this is
  // `defadvice ... (interactive ...)`, which rewrites the command's *arguments*; jemacs
  // commands read the region off the buffer, so the equivalent is to set a temporary
  // whole-line region before the command runs.
  const slickBefore = (describe: string) => ({ editor, buffer }: { editor: Editor; buffer: BufferModel }) => {
    if (!(getCustom<boolean>("slick-copy") ?? true)) return
    if (activeRegion(buffer)) return
    const start = lineBeginningPosition(buffer)
    const end = nextLineBeginningPosition(buffer)
    if (start === end) return
    buffer.mark = start
    buffer.point = end
    buffer.markActive = true
    if (describe) editor.message(describe)
  }

  ctx.advice("kill-ring-save", { before: slickBefore("Single line copied") })
  ctx.advice("kill-region", { before: slickBefore("") })

  // ── Buffer housekeeping ─────────────────────────────────────────────────

  ctx.command("my/kill-other-buffers", ({ editor }) => {
    const current = editor.currentBuffer
    let killed = 0
    for (const buffer of [...editor.buffers.values()]) {
      if (buffer.id === current.id) continue
      if (editor.killBuffer(buffer)) killed++
    }
    editor.message(`Other buffers killed (${killed})`)
  }, "Kill all buffers except the current one.")

  ctx.command("my/close-tramp-buffers", ({ editor }) => {
    let count = 0
    for (const buffer of [...editor.buffers.values()]) {
      const remote = buffer.name.includes("ssh")
        || (buffer.path != null && /^\/[^/:]+:/.test(buffer.path))
      if (remote && editor.killBuffer(buffer)) count++
    }
    editor.message(`Closed ${count} remote/ssh buffers.`)
  }, "Kill all tramp/ssh buffers.")

  // ── protobuf helpers ────────────────────────────────────────────────────

  ctx.command("proto-add-rpc", async ({ editor, buffer, args }) => {
    const name = args[0] ?? await editor.prompt("Enter the function name: ")
    if (!name) return
    buffer.insert(`rpc ${name}(${name}Request) returns (${name}Response);\n`)
    buffer.point = buffer.text.length
    buffer.insert(`\nmessage ${name}Request {}\nmessage ${name}Response {}\n`)
  }, "Insert a gRPC method plus its request/response messages.")

  ctx.command("proto-renumber", ({ editor, buffer }) => {
    const region = activeRegion(buffer)
    if (!region) {
      editor.message("You must select a region first!")
      return
    }
    const [start, end] = region
    const renumbered = renumberProtoFields(buffer.text.slice(start, end))
    buffer.replaceRange(start, end, renumbered)
    editor.message("Renumbered protobuf fields")
  }, "Renumber the selected protobuf field tags in ascending order.")

  // ── string-inflection ───────────────────────────────────────────────────

  ctx.command("string-inflection-cycle", ({ editor, buffer }) => {
    const bounds = symbolBounds(buffer)
    if (!bounds) {
      editor.message("No symbol at point")
      return
    }
    const [start, end] = bounds
    const next = cycleInflection(buffer.text.slice(start, end))
    buffer.replaceRange(start, end, next)
    buffer.point = start + next.length
    editor.message(next)
  }, "Cycle the symbol at point between snake_case, camelCase, PascalCase and UPPER_SNAKE.")

  // ── ace-jump compatibility ──────────────────────────────────────────────
  //
  // jemacs ships avy, which is the same idea under its modern name. Alias rather than
  // reimplement so `C-c SPC` works without teaching two jump systems.
  if (editor.commands.get("avy-goto-word-1")) {
    ctx.command("ace-jump-word-mode", async ({ editor, args }) => {
      await editor.run("avy-goto-word-1", args)
    }, "Jump to a word (alias for avy-goto-word-1).")
    ctx.key("global", "C-c SPC", "ace-jump-word-mode")
  }
  if (editor.commands.get("avy-goto-char")) {
    ctx.command("ace-jump-char-mode", async ({ editor, args }) => {
      await editor.run("avy-goto-char", args)
    }, "Jump to a character (alias for avy-goto-char).")
    ctx.key("global", "C-c C-x SPC", "ace-jump-char-mode")
  }

  ctx.key("global", "C-c n", "proto-renumber")

  installFolding(editor, ctx)
  installSessionCommands(editor, ctx)

  // delete-selection-mode is NOT enabled here. Like Emacs, it is off by default and
  // opted into from the user's init file, so loading this plugin does not silently
  // change what typing over a region does for everybody.
}

/**
 * `yafolding`: fold the indented block under point.
 *
 * The fold is applied by wrapping each mode's `displayFilter` rather than defining a
 * global one, because `modeFeature` resolves a single method per mode -- defining ours
 * outright would silently disable markdown's markup hiding or org's own folding.
 */
function installFolding(editor: Editor, ctx: PluginContext): void {
  const wrapped = new Set<string>()

  /** Compose folding over whatever filter `mode` already has. */
  const wrapMode = (mode: string): void => {
    if (wrapped.has(mode)) return
    wrapped.add(mode)
    const inner = modeFeature(mode, "displayFilter")
    defmethod("display-filter", mode, (buffer: BufferModel) => {
      const base = inner?.(buffer) ?? null
      const folded = buffer.locals.get(FOLDED_LINES)
      if (!(folded instanceof Set) || folded.size === 0) return base
      // Fold the text the mode already produced, then compose the two offset maps so
      // point still round-trips through both transformations.
      const source = base?.text ?? buffer.text
      const fold = foldDisplay(source, folded as Set<number>)
      if (!fold) return base
      if (!base) return fold
      return {
        text: fold.text,
        map: (n: number) => fold.map(base.map(n)),
        unmap: (n: number) => (base.unmap ? base.unmap(fold.unmap(n)) : fold.unmap(n)),
      }
    })
  }

  const toggleAt = (buffer: BufferModel, line: number): boolean => {
    const folded = foldedLines(buffer)
    if (folded.has(line)) {
      folded.delete(line)
      return false
    }
    if (!elementRange(buffer.text.split("\n"), line)) return false
    folded.add(line)
    wrapMode(buffer.mode)
    return true
  }

  ctx.command("yafolding-toggle-element", ({ editor, buffer }) => {
    const line = lineIndexAt(buffer)
    const folded = toggleAt(buffer, line)
    if (!folded && !foldedLines(buffer).has(line)) {
      editor.message(foldedLines(buffer).size ? "Unfolded" : "Nothing to fold at point")
    }
    void editor.changed("yafolding")
  }, "Fold or unfold the indented block starting at point.")

  ctx.command("yafolding-toggle-all", ({ editor, buffer }) => {
    const folded = foldedLines(buffer)
    if (folded.size) {
      folded.clear()
      editor.message("Unfolded all")
    } else {
      const lines = buffer.text.split("\n")
      for (let i = 0; i < lines.length; i++) {
        if (elementRange(lines, i)) folded.add(i)
      }
      wrapMode(buffer.mode)
      editor.message(`Folded ${folded.size} blocks`)
    }
    void editor.changed("yafolding")
  }, "Fold or unfold every indented block in the buffer.")

  ctx.command("yafolding-show-all", ({ editor, buffer }) => {
    foldedLines(buffer).clear()
    void editor.changed("yafolding")
    editor.message("Unfolded all")
  }, "Unfold every block in the buffer.")

  ctx.key("global", "C-c RET", "yafolding-toggle-element")
}

/** `restart-emacs` and `auto-save-visited-mode`. */
function installSessionCommands(editor: Editor, ctx: PluginContext): void {
  ctx.command("restart-emacs", async ({ editor }) => {
    const unsaved = [...editor.buffers.values()].filter(b => b.dirty && b.path)
    if (unsaved.length) {
      const answer = await editor.prompt(
        `Save ${unsaved.length} modified buffer(s) before restarting? (y/n/c) `,
      )
      if (answer == null || answer.startsWith("c")) return
      if (answer.startsWith("y")) {
        // buffer.save() directly, rather than running save-buffer per buffer: the
        // command always targets the *current* buffer, and switching to each in turn
        // would leave the user somewhere unexpected if the restart is cancelled.
        for (const buffer of unsaved) {
          try {
            await buffer.save(saveContextOptions())
          } catch (err) {
            editor.message(`Could not save ${buffer.name}: ${(err as Error).message}`)
            return
          }
        }
      }
    }
    editor.message("Restarting jemacs…")
    // Re-exec argv rather than spawning a detached child: the terminal, tty and
    // job-control state all belong to this process.
    const { spawn } = await import("node:child_process")
    const child = spawn(process.argv[0]!, process.argv.slice(1), {
      detached: true,
      stdio: "inherit",
    })
    child.unref()
    process.exit(0)
  }, "Restart jemacs, offering to save modified buffers first.")

  defineMinorMode({
    name: "auto-save-visited-mode",
    lighter: "",
    global: true,
  })

  // Save the *visited file* (not an auto-save file) on an idle timer, which is what
  // makes markdown notes feel like a notes app rather than a text editor.
  let timer: ReturnType<typeof setInterval> | null = null
  const stop = () => {
    if (timer) clearInterval(timer)
    timer = null
  }
  const start = () => {
    if (timer) return
    const seconds = Math.max(1, getCustom<number>("auto-save-visited-interval") ?? 1)
    timer = setInterval(() => {
      if (!editor.globalMinorModes.has("auto-save-visited-mode")) return
      // Emacs sets `auto-save-visited-predicate` to markdown-only; an empty list here
      // means "every file-visiting buffer", matching stock Emacs behaviour.
      const modes = getCustom<string[]>("auto-save-visited-modes") ?? []
      for (const buffer of editor.buffers.values()) {
        if (!buffer.dirty || !buffer.path) continue
        if (modes.length && !modes.includes(buffer.mode)) continue
        if (editor.minibuffer) continue
        // Failures are intentionally silent: an idle timer must never interrupt typing
        // with an error popup. A real save via C-x C-s still reports normally.
        void buffer.save(saveContextOptions()).catch(() => {})
      }
    }, seconds * 1000)
    ;(timer as { unref?: () => void }).unref?.()
  }

  ctx.command("auto-save-visited-mode", ({ editor, prefixArgument }) => {
    const enable = prefixArgument == null
      ? !editor.globalMinorModes.has("auto-save-visited-mode")
      : prefixArgument > 0
    if (enable) {
      editor.enableMinorMode("auto-save-visited-mode")
      start()
      editor.message("Auto-saving visited files")
    } else {
      editor.disableMinorMode("auto-save-visited-mode")
      stop()
      editor.message("Auto-save-visited disabled")
    }
  }, "Periodically save file-visiting buffers to their own files.")

  ctx.onDispose(stop)
}
