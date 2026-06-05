import type { Editor } from "../../src/kernel/editor"
import type { BufferModel } from "../../src/kernel/buffer"
import { defineMinorMode } from "../../src/modes/minor-mode"
import { addHook } from "../../src/kernel/hooks"
import { defcustom, getCustom } from "../../src/runtime/custom"

const SUBWORD_FORWARD = "[^A-Za-z0-9]*(?:[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z0-9]+|[A-Z]+)"
const SUBWORD_BACKWARD = "[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z0-9]+|[A-Z]+"

defcustom("subword-forward-regexp", "string", SUBWORD_FORWARD,
  "Regexp matching one subword after point, with leading non-word skip.")
defcustom("subword-backward-regexp", "string", SUBWORD_BACKWARD,
  "Regexp matching a single subword token; the last match before point is its start.")

function applySubword(buffer: BufferModel | null): void {
  if (!buffer) return
  buffer.locals.set("word-forward-regexp", getCustom<string>("subword-forward-regexp") ?? SUBWORD_FORWARD)
  buffer.locals.set("word-backward-regexp", getCustom<string>("subword-backward-regexp") ?? SUBWORD_BACKWARD)
}

function clearSubword(buffer: BufferModel | null): void {
  if (!buffer) return
  buffer.locals.delete("word-forward-regexp")
  buffer.locals.delete("word-backward-regexp")
}

defineMinorMode({
  name: "subword-mode",
  lighter: " ,",
  onEnable: (_editor, buffer) => applySubword(buffer),
  onDisable: (_editor, buffer) => clearSubword(buffer),
})

defineMinorMode({
  name: "global-subword-mode",
  lighter: " ,",
  global: true,
  onEnable: editor => {
    for (const buffer of editor.buffers.values()) applySubword(buffer)
    addHook("find-file-hook", ({ buffer }) => applySubword(buffer))
  },
  onDisable: editor => {
    for (const buffer of editor.buffers.values()) clearSubword(buffer)
  },
})

export function install(editor: Editor): void {
  editor.command("subword-mode", ({ editor, buffer, prefixArgument }) => {
    if (prefixArgument != null && prefixArgument <= 0) editor.disableMinorMode("subword-mode", { buffer })
    else if (prefixArgument != null) editor.enableMinorMode("subword-mode", { buffer })
    else editor.toggleMinorMode("subword-mode", { buffer })
  }, "Toggle subword movement: word commands stop at CamelCase and snake_case boundaries.")

  editor.command("global-subword-mode", ({ editor, prefixArgument }) => {
    if (prefixArgument != null && prefixArgument <= 0) editor.disableMinorMode("global-subword-mode")
    else if (prefixArgument != null) editor.enableMinorMode("global-subword-mode")
    else editor.toggleMinorMode("global-subword-mode")
  }, "Toggle Subword mode in all buffers.")

  editor.command("subword-forward", ({ buffer, prefixArgument }) => {
    const n = prefixArgument ?? 1
    const dir = n >= 0 ? 1 : -1
    const had = buffer.locals.has("word-forward-regexp")
    if (!had) applySubword(buffer)
    for (let i = 0; i < Math.abs(n); i++) buffer.moveWord(dir)
    if (!had) clearSubword(buffer)
  }, "Move point forward one subword.")

  editor.command("subword-backward", ({ buffer, prefixArgument }) => {
    const n = prefixArgument ?? 1
    const dir = n >= 0 ? -1 : 1
    const had = buffer.locals.has("word-forward-regexp")
    if (!had) applySubword(buffer)
    for (let i = 0; i < Math.abs(n); i++) buffer.moveWord(dir)
    if (!had) clearSubword(buffer)
  }, "Move point backward one subword.")
}
