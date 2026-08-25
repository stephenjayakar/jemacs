import { homedir } from "node:os"
import type { Editor } from "../../src/kernel/editor"
import type { BufferModel } from "../../src/kernel/buffer"
import { Keymap } from "../../src/kernel/keymap"
import { createPluginContext, type PluginContext } from "../../src/runtime/plugin-context"

const VIEW_READ_ONLY_LOCAL = "view-mode-original-read-only"

function rememberReadOnly(buffer: BufferModel): void {
  if (!buffer.locals.has(VIEW_READ_ONLY_LOCAL)) {
    buffer.locals.set(VIEW_READ_ONLY_LOCAL, buffer.readOnly)
  }
  buffer.readOnly = true
}

function restoreReadOnly(buffer: BufferModel): void {
  const original = buffer.locals.get(VIEW_READ_ONLY_LOCAL)
  if (typeof original === "boolean") buffer.readOnly = original
  buffer.locals.delete(VIEW_READ_ONLY_LOCAL)
}

function disableViewMode(editor: Editor, buffer: BufferModel): void {
  if (editor.isMinorModeEnabled("view-mode", buffer)) editor.disableMinorMode("view-mode", { buffer })
}

function editableViewExit(editor: Editor, buffer: BufferModel): void {
  disableViewMode(editor, buffer)
  buffer.readOnly = false
  editor.message("View mode exited")
}

function startOrRepeatSearch(editor: Editor, direction: 1 | -1): void {
  if (editor.isearch) {
    editor.isearch.direction = direction
    editor.isearchRepeat()
    return
  }

  const last = editor.searchRing.at(-1)
  if (!last) {
    editor.message("No previous search string")
    return
  }

  editor.startIsearch(direction)
  editor.setIsearchString(last)
  editor.endIsearch()
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

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  const viewModeMap = new Keymap("view-mode-map")
  viewModeMap.bind("SPC", "scroll-up-command")
  viewModeMap.bind("DEL", "scroll-down-command")
  viewModeMap.bind("S-SPC", "scroll-down-command")
  viewModeMap.bind("<", "beginning-of-buffer")
  viewModeMap.bind(">", "end-of-buffer")
  viewModeMap.bind("g", "goto-line")
  viewModeMap.bind("/", "isearch-forward")
  viewModeMap.bind("n", "View-search-last-regexp-forward")
  viewModeMap.bind("p", "View-search-last-regexp-backward")
  viewModeMap.bind("q", "View-quit")
  viewModeMap.bind("e", "View-exit")
  viewModeMap.bind("E", "View-exit-and-edit")

  ctx.minorMode({
    name: "view-mode",
    lighter: " View",
    keymap: viewModeMap,
    onEnable: (_ed, buffer) => { if (buffer) rememberReadOnly(buffer) },
    onDisable: (_ed, buffer) => { if (buffer) restoreReadOnly(buffer) },
  })

  ctx.command("view-mode", ({ editor, buffer, prefixArgument }) => {
    if (prefixArgument != null && prefixArgument > 0) editor.enableMinorMode("view-mode", { buffer })
    else if (prefixArgument != null && prefixArgument <= 0) editor.disableMinorMode("view-mode", { buffer })
    else editor.toggleMinorMode("view-mode", { buffer })
  }, "Toggle View mode.")

  ctx.command("View-quit", ({ editor, buffer }) => {
    disableViewMode(editor, buffer)
    editor.message("View mode disabled")
  }, "Quit View mode, restoring the buffer's previous read-only state.")

  ctx.command("View-exit", ({ editor, buffer }) => {
    disableViewMode(editor, buffer)
    editor.message("View mode disabled")
  }, "Exit View mode but stay in the current buffer.")

  ctx.command("View-exit-and-edit", ({ editor, buffer }) => {
    editableViewExit(editor, buffer)
  }, "Exit View mode and make the buffer editable.")

  ctx.command("View-search-last-regexp-forward", ({ editor }) => {
    startOrRepeatSearch(editor, 1)
  }, "Repeat the last View mode search forward.")

  ctx.command("View-search-last-regexp-backward", ({ editor }) => {
    startOrRepeatSearch(editor, -1)
  }, "Repeat the last View mode search backward.")

  ctx.command("view-buffer", async ({ editor, args }) => {
    const input = args[0] ?? await editor.completingRead("View buffer: ", {
      collection: [...editor.buffers.values()].map(b => editor.bufferDisplayName(b)),
      history: "buffer",
    })
    if (!input) return
    const buffer = editor.switchToBuffer(input)
    editor.enableMinorMode("view-mode", { buffer })
    editor.message(`Viewing ${editor.bufferDisplayName(buffer)}`)
  }, "View an existing buffer read-only.")

  ctx.command("view-file", async ({ editor, args }) => {
    const input = args[0] ?? await editor.completingRead("View file: ", {
      completion: "file",
      history: "file",
      initialValue: directoryInitialValue(editor.currentBuffer.directory() ?? process.cwd()),
    })
    if (!input) return
    const path = substituteInFileName(input)
    const buffer = await editor.openFile(path)
    editor.enableMinorMode("view-mode", { buffer })
    editor.message(`Viewing ${path}`)
  }, "Open a file and enable View mode.")
}
