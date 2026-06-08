import type { Editor } from "../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../src/runtime/plugin-context"
import { findWindowLeaf, listWindowLeaves, nextWindowId, scrollWindowLeaf } from "../src/kernel/window"
import { pageScrollLines } from "../src/display/viewport"
import { defvar } from "../src/runtime/custom"
import { bufferListEntryAtPoint, showBufferList } from "../src/modes/buffer-list"
import { directoryInitialValue, substituteInFileName } from "./files"

const recenterCycle = defvar("recenter--cycle", new WeakMap<Editor, number>(),
  "Per-editor C-l cycle state (center → top → bottom).").value

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  const otherWindow = (editor: Editor, delta: number) => {
    if (listWindowLeaves(editor.windowLayout).length <= 1) return
    editor.selectWindow(nextWindowId(editor.windowLayout, editor.selectedWindowId, delta))
  }

  const switchTab = (editor: Editor, delta: number) => {
    if (!editor.tabs.length) return
    editor.selectedTab = (editor.selectedTab + delta + editor.tabs.length) % editor.tabs.length
    editor.switchToBuffer(editor.tabs[editor.selectedTab]!.bufferId)
  }

  const cycleBuffer = (editor: Editor, delta: number) => {
    const values = [...editor.buffers.values()].filter(b => b.kind !== "minibuffer")
    const i = values.findIndex(b => b.id === editor.currentBufferId)
    return editor.switchToBuffer(values[(i + delta + values.length) % values.length]!.id)
  }

  editor.command("delete-window", ({ editor }) => editor.deleteWindow(), "Delete the selected window.")

  editor.command("delete-other-windows", ({ editor }) => {
    editor.deleteOtherWindows()
    editor.message("Deleted other windows")
  }, "Keep the selected window and delete all others.")

  editor.command("split-window-below", ({ editor }) => editor.splitWindowBelow(), "Split the selected window below.")
  editor.command("split-window-right", ({ editor }) => editor.splitWindowRight(), "Split the selected window to the right.")

  const previousWindow = ({ editor }: { editor: Editor }) => otherWindow(editor, -1)
  editor.command("other-window", ({ editor }) => otherWindow(editor, 1), "Select another window.")
  editor.command("other-window-backward", previousWindow, "Compatibility alias for previous-window-any-frame.")
  editor.command("next-window-any-frame", ({ editor }) => otherWindow(editor, 1), "Select the next window.")
  editor.command("previous-window-any-frame", previousWindow, "Select the previous window.")

  editor.command("recenter-top-bottom", ({ editor }) => {
    if (!editor.selectedWindowLeaf()) return
    const page = pageScrollLines()
    const lineIdx = editor.currentBuffer.lineCol().line - 1
    const cycle = recenterCycle.get(editor) ?? 0
    const start = cycle === 0 ? Math.max(0, lineIdx - Math.floor(page / 2))
      : cycle === 1 ? lineIdx
      : Math.max(0, lineIdx - page + 1)
    editor.setSelectedWindowStartLine(start)
    recenterCycle.set(editor, (cycle + 1) % 3)
    editor.message("Recenter")
  }, "Center point vertically in the window.")

  const scrollOther = (editor: Editor, delta: number): boolean => {
    if (listWindowLeaves(editor.windowLayout).length <= 1) return false
    const otherId = nextWindowId(editor.windowLayout, editor.selectedWindowId, 1)
    const leaf = findWindowLeaf(editor.windowLayout, otherId)
    if (!leaf) return false
    const buffer = editor.buffers.get(leaf.bufferId)
    const maxStart = Math.max(0, (buffer ? buffer.text.split("\n").length : 1) - 1)
    const lines = pageScrollLines() * delta
    editor.mutateWindowLayout(layout => scrollWindowLeaf(layout, otherId, lines, maxStart), "scroll-other-window")
    return true
  }

  editor.command("scroll-other-window", ({ editor, prefixArgument }) => {
    if (!scrollOther(editor, prefixArgument ?? 1)) editor.message("No other window to scroll")
  }, "Scroll the next window forward without selecting it.")

  editor.command("scroll-other-window-down", ({ editor, prefixArgument }) => {
    if (!scrollOther(editor, -(prefixArgument ?? 1))) editor.message("No other window to scroll")
  }, "Scroll the next window backward without selecting it.")

  editor.command("switch-to-buffer-other-window", async ({ editor, args }) => {
    const name = args[0] ?? await editor.completingRead("Switch to buffer in other window: ", {
      collection: [...editor.buffers.values()].map(b => editor.bufferDisplayName(b)),
      history: "buffer",
    })
    if (!name) return
    const target = editor.buffers.get(name)
      ?? [...editor.buffers.values()].find(b => b.name === name || editor.bufferDisplayName(b) === name)
    const shown = editor.displayBufferInOtherWindow(target?.id ?? name)
    editor.message(`Switched to ${editor.bufferDisplayName(shown)} in other window`)
  }, "Switch to a buffer in another window.")

  editor.command("find-file-other-window", async ({ editor, args }) => {
    const input = args[0] ?? await editor.completingRead("Find file in other window: ", {
      completion: "file",
      history: "file",
      initialValue: directoryInitialValue(editor.currentBuffer.directory() ?? process.cwd()),
    })
    if (!input) return
    editor.ensureOtherWindowSelected()
    const buffer = await editor.openFile(substituteInFileName(input))
    editor.message(`Now visiting ${editor.bufferDisplayName(buffer)} in other window`)
  }, "Find a file in another window.")

  const displayBuffer = async ({ editor, args }: { editor: Editor; args: string[] }) => {
    const name = args[0] ?? await editor.completingRead("Display buffer in other window: ", {
      collection: [...editor.buffers.values()].map(b => editor.bufferDisplayName(b)),
      history: "buffer",
      initialValue: editor.bufferDisplayName(editor.currentBuffer),
    })
    if (!name) return
    const target = editor.buffers.get(name)
      ?? [...editor.buffers.values()].find(b => b.name === name || editor.bufferDisplayName(b) === name)
    const shown = editor.displayBufferInOtherWindow(target?.id ?? name)
    editor.message(`Displayed ${editor.bufferDisplayName(shown)} in other window`)
  }
  editor.command("display-buffer", displayBuffer, "Display a buffer in another window and select it.")
  editor.command("display-buffer-other-window", displayBuffer, "Compatibility alias for display-buffer.")

  editor.command("toggle-window-dedicated", ({ editor }) => {
    const leaf = editor.selectedWindowLeaf()
    const dedicated = !(leaf?.dedicated ?? false)
    editor.setSelectedWindowDedicated(dedicated)
    editor.message(dedicated ? "Window is now dedicated" : "Window is no longer dedicated")
  }, "Toggle whether the selected window is dedicated.")

  editor.command("quit-window", ({ editor }) => {
    editor.deleteWindow()
    if (listWindowLeaves(editor.windowLayout).length === 1) cycleBuffer(editor, 1)
  }, "Bury the current special buffer and select another buffer.")

  editor.command("window-configuration-to-register", async ({ editor, args }) => {
    const register = args[0] ?? await editor.prompt("Window configuration to register: ", "w", "register")
    if (!register) return
    editor.registers.set(register, editor.currentWindowConfiguration())
    editor.message(`Saved window configuration to register ${register}`)
  }, "Save the current window configuration to a register.")

  editor.command("tab-bar-new-tab", ({ editor }) => {
    editor.tabs.push({ name: String(editor.tabs.length + 1), bufferId: editor.currentBufferId })
    editor.selectedTab = editor.tabs.length - 1
  }, "Create a new tab.")

  editor.command("tab-bar-close-tab", ({ editor }) => {
    if (editor.tabs.length <= 1) return
    editor.tabs.splice(editor.selectedTab, 1)
    editor.selectedTab = Math.min(editor.selectedTab, editor.tabs.length - 1)
    editor.switchToBuffer(editor.tabs[editor.selectedTab]!.bufferId)
  }, "Close the current tab.")

  editor.command("tab-bar-switch-to-next-tab", ({ editor }) => switchTab(editor, 1), "Switch to the next tab.")
  editor.command("tab-bar-switch-to-prev-tab", ({ editor }) => switchTab(editor, -1), "Switch to the previous tab.")

  editor.command("next-buffer", ({ editor }) => {
    const b = cycleBuffer(editor, 1)
    editor.message(`Switched to ${editor.bufferDisplayName(b)}`)
  }, "Switch to the next buffer.")

  editor.command("previous-buffer", ({ editor }) => {
    const b = cycleBuffer(editor, -1)
    editor.message(`Switched to ${editor.bufferDisplayName(b)}`)
  }, "Switch to the previous buffer.")

  editor.command("switch-to-buffer", async ({ editor, args }) => {
    const name = args[0] ?? await editor.completingRead("Switch to buffer: ", { collection: [...editor.buffers.values()].map(b => editor.bufferDisplayName(b)), history: "buffer" })
    if (!name) return
    const buffer = editor.switchToBuffer(name)
    editor.message(`Switched to ${editor.bufferDisplayName(buffer)}`)
  }, "Prompt for a buffer name and switch to it.")

  editor.command("list-buffers", ({ editor }) => {
    showBufferList(editor)
  }, "Display the buffer list.")

  editor.command("buffer-list-select", ({ buffer, editor }) => {
    const bufferId = bufferListEntryAtPoint(buffer)
    if (!bufferId) return
    const target = editor.buffers.get(bufferId)
    if (!target) return
    editor.switchToBuffer(target.id)
    editor.message(`Switched to ${editor.bufferDisplayName(target)}`)
  }, "Switch to the buffer on the current buffer-list line.")

  editor.key("C-x 0", "delete-window")
  editor.key("C-x 1", "delete-other-windows")
  editor.key("C-x 2", "split-window-below")
  editor.key("C-x 3", "split-window-right")
  editor.key("C-x o", "other-window")
  // GNU Emacs: C-tab → other-window; C-S-tab → (other-window -1). Also accept common terminal names.
  for (const key of ["C-tab"]) editor.key(key, "other-window")
  for (const key of ["C-S-tab", "C-S-iso-lefttab", "C-iso-lefttab", "C-backtab"]) {
    editor.key(key, "previous-window-any-frame")
  }
  editor.key("C-l", "recenter-top-bottom")
  editor.key("C-M-v", "scroll-other-window")
  editor.key("M-C-v", "scroll-other-window-down")
  editor.key("C-x 4 b", "switch-to-buffer-other-window")
  editor.key("C-x 4 C-f", "find-file-other-window")
  editor.key("C-x 4 f", "find-file-other-window")
  editor.key("C-x 4 C-o", "display-buffer")
  editor.key("C-x r w", "window-configuration-to-register")
  editor.key("C-M-tab", "tab-bar-switch-to-next-tab")
  editor.key("C-M-S-tab", "tab-bar-switch-to-prev-tab")
  editor.key("s-}", "tab-bar-switch-to-next-tab")
  editor.key("s-{", "tab-bar-switch-to-prev-tab")
  editor.key("s-t", "tab-bar-new-tab")
  editor.key("s-w", "tab-bar-close-tab")
}
