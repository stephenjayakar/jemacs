import type { Editor } from "../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../src/runtime/plugin-context"
import type { ChildFrameParameters, ChildFrameRecord } from "../src/kernel/window"
import { findWindowLeaf, listWindowLeaves, nextWindowId, scrollWindowLeaf } from "../src/kernel/window"
import { pageScrollLines } from "../src/display/viewport"
import { defvar } from "../src/runtime/custom"
import { bufferListEntryAtPoint, showBufferList } from "../src/modes/buffer-list"
import { directoryInitialValue, substituteInFileName } from "./files"

const recenterCycle = defvar("recenter--cycle", new WeakMap<Editor, number>(),
  "Per-editor C-l cycle state (center → top → bottom).").value

export type DisplayBufferActionFunction =
  | "display-buffer-in-child-frame"
  | "display-buffer-pop-up-window"
  | "display-buffer-use-some-window"
  | "display-buffer-reuse-window"

export type DisplayBufferActionAlist = {
  action?: DisplayBufferActionFunction
  "child-frame-parameters"?: ChildFrameParameters
  select?: boolean
}

export function displayBufferInChildFrame(
  editor: Editor,
  bufferOrName: string,
  alist: DisplayBufferActionAlist = {},
): ChildFrameRecord {
  return editor.displayBufferInChildFrame(bufferOrName, {
    childFrameParameters: alist["child-frame-parameters"],
  })
}

export function displayBuffer(editor: Editor, bufferOrName: string, alist: DisplayBufferActionAlist = {}) {
  if (alist.action === "display-buffer-in-child-frame") return displayBufferInChildFrame(editor, bufferOrName, alist)
  return editor.displayBufferInOtherWindow(bufferOrName, { select: alist.select ?? false })
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  const otherWindow = (editor: Editor, delta: number) => {
    if (listWindowLeaves(editor.windowLayout).length <= 1) return
    editor.selectWindow(nextWindowId(editor.windowLayout, editor.selectedWindowId, delta))
  }

  const switchTab = (editor: Editor, delta: number) => {
    if (!editor.tabs.length) return
    editor.selectedTab = ((editor.selectedTab + delta) % editor.tabs.length + editor.tabs.length) % editor.tabs.length
    editor.switchToBuffer(editor.tabs[editor.selectedTab]!.bufferId)
  }

  const closeTab = (editor: Editor, tabNumber: number | null) => {
    if (editor.tabs.length <= 1) return
    const target = tabNumber != null && tabNumber > 0 ? tabNumber - 1 : editor.selectedTab
    if (target < 0 || target >= editor.tabs.length) return
    editor.tabs.splice(target, 1)
    if (target < editor.selectedTab) editor.selectedTab--
    else if (target === editor.selectedTab) editor.selectedTab = Math.min(editor.selectedTab, editor.tabs.length - 1)
    editor.switchToBuffer(editor.tabs[editor.selectedTab]!.bufferId)
  }

  const newTab = (editor: Editor, prefixArgument: number | null) => {
    const offset = prefixArgument ?? 1
    const target = Math.max(0, Math.min(editor.tabs.length, editor.selectedTab + offset))
    const bufferId = editor.currentBufferId
    editor.tabs.splice(target, 0, { name: String(editor.tabs.length + 1), bufferId })
    editor.selectedTab = target
    editor.switchToBuffer(bufferId)
  }

  const cycleBuffer = (editor: Editor, delta: number) => {
    const values = [...editor.buffers.values()].filter(b => b.kind !== "minibuffer")
    const i = values.findIndex(b => b.id === editor.currentBufferId)
    const next = ((i + delta) % values.length + values.length) % values.length
    return editor.switchToBuffer(values[next]!.id)
  }

  const resolveBufferName = (editor: Editor, name: string) =>
    editor.buffers.get(name)
      ?? [...editor.buffers.values()].find(b => b.name === name || editor.bufferDisplayName(b) === name)

  editor.command("delete-window", ({ editor }) => editor.deleteWindow(), "Delete the selected window.")

  editor.command("delete-other-windows", ({ editor }) => {
    editor.deleteOtherWindows()
    editor.message("Deleted other windows")
  }, "Keep the selected window and delete all others.")

  editor.command("split-window-below", ({ editor }) => editor.splitWindowBelow(), "Split the selected window below.")
  editor.command("split-window-right", ({ editor }) => editor.splitWindowRight(), "Split the selected window to the right.")

  const previousWindow = ({ editor }: { editor: Editor }) => otherWindow(editor, -1)
  editor.command("other-window", ({ editor, prefixArgument }) => otherWindow(editor, prefixArgument ?? 1), "Select another window.")
  editor.command("jemacs-other-window-backward", previousWindow, "Jemacs extension alias for previous-window-any-frame.")
  editor.command("next-window-any-frame", ({ editor }) => otherWindow(editor, 1), "Select the next window.")
  editor.command("previous-window-any-frame", previousWindow, "Select the previous window.")

  editor.command("recenter-top-bottom", ({ editor, prefixArgument }) => {
    if (!editor.selectedWindowLeaf()) return
    const page = pageScrollLines(editor.lastViewport?.rows)
    const lineIdx = editor.currentBuffer.lineCol().line - 1
    if (prefixArgument != null) {
      const targetRow = prefixArgument >= 0 ? prefixArgument : Math.max(0, page + prefixArgument)
      editor.setSelectedWindowStartLine(Math.max(0, lineIdx - targetRow))
      editor.message("Recenter")
      return
    }
    const cycle = recenterCycle.get(editor) ?? 0
    const start = cycle === 0 ? Math.max(0, lineIdx - Math.floor(page / 2))
      : cycle === 1 ? lineIdx
      : Math.max(0, lineIdx - page + 1)
    editor.setSelectedWindowStartLine(start)
    recenterCycle.set(editor, (cycle + 1) % 3)
    editor.message("Recenter")
  }, "Center point vertically in the window.")

  const scrollOther = (editor: Editor, lines: number): boolean => {
    if (listWindowLeaves(editor.windowLayout).length <= 1) return false
    const otherId = nextWindowId(editor.windowLayout, editor.selectedWindowId, 1)
    const leaf = findWindowLeaf(editor.windowLayout, otherId)
    if (!leaf) return false
    const buffer = editor.buffers.get(leaf.bufferId)
    const maxStart = Math.max(0, (buffer ? buffer.text.split("\n").length : 1) - 1)
    editor.mutateWindowLayout(layout => scrollWindowLeaf(layout, otherId, lines, maxStart), "scroll-other-window")
    return true
  }

  editor.command("scroll-other-window", ({ editor, prefixArgument }) => {
    if (!scrollOther(editor, prefixArgument ?? pageScrollLines(editor.lastViewport?.rows))) editor.message("No other window to scroll")
  }, "Scroll the next window forward without selecting it.")

  editor.command("scroll-other-window-down", ({ editor, prefixArgument }) => {
    if (!scrollOther(editor, -(prefixArgument ?? pageScrollLines(editor.lastViewport?.rows)))) editor.message("No other window to scroll")
  }, "Scroll the next window backward without selecting it.")

  editor.command("switch-to-buffer-other-window", async ({ editor, args }) => {
    const name = args[0] ?? await editor.completingRead("Switch to buffer in other window: ", {
      collection: [...editor.buffers.values()].map(b => editor.bufferDisplayName(b)),
      history: "buffer",
    })
    if (!name) return
    const target = resolveBufferName(editor, name)
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

  const displayBufferCommand = async ({ editor, args }: { editor: Editor; args: string[] }) => {
    const name = args[0] ?? await editor.completingRead("Display buffer in other window: ", {
      collection: [...editor.buffers.values()].map(b => editor.bufferDisplayName(b)),
      history: "buffer",
      initialValue: editor.bufferDisplayName(editor.currentBuffer),
    })
    if (!name) return
    const target = resolveBufferName(editor, name)
    const action = args[1] as DisplayBufferActionFunction | undefined
    const result = displayBuffer(editor, target?.id ?? name, { action, select: false })
    const shown = "window" in result ? editor.buffers.get(result.window.bufferId) : result
    editor.message(`Displayed ${shown ? editor.bufferDisplayName(shown) : name}${action === "display-buffer-in-child-frame" ? " in child frame" : " in other window"}`)
    return result
  }
  editor.command("display-buffer", displayBufferCommand, "Display a buffer in another window without selecting it.")
  editor.command("jemacs-display-buffer-other-window", displayBufferCommand, "Jemacs extension alias for display-buffer.")

  editor.command("display-buffer-in-child-frame", async ({ editor, args }) => {
    const name = args[0] ?? await editor.completingRead("Display buffer in child frame: ", {
      collection: [...editor.buffers.values()].map(b => editor.bufferDisplayName(b)),
      history: "buffer",
      initialValue: editor.bufferDisplayName(editor.currentBuffer),
    })
    if (!name) return
    const target = resolveBufferName(editor, name)
    const frame = displayBufferInChildFrame(editor, target?.id ?? name)
    const shown = editor.buffers.get(frame.window.bufferId)
    editor.message(`Displayed ${shown ? editor.bufferDisplayName(shown) : name} in child frame`)
    return frame
  }, "Display a buffer in a child frame of the selected frame.")

  editor.command("pop-to-buffer", async ({ editor, args }) => {
    const name = args[0] ?? await editor.completingRead("Pop to buffer: ", {
      collection: [...editor.buffers.values()].map(b => editor.bufferDisplayName(b)),
      history: "buffer",
      initialValue: editor.bufferDisplayName(editor.currentBuffer),
    })
    if (!name) return
    const target = resolveBufferName(editor, name)
    const shown = editor.displayBufferInOtherWindow(target?.id ?? name)
    editor.message(`Popped to ${editor.bufferDisplayName(shown)}`)
  }, "Display a buffer and select its window.")

  editor.command("jemacs-toggle-window-dedicated", ({ editor }) => {
    const leaf = editor.selectedWindowLeaf()
    const dedicated = !(leaf?.dedicated ?? false)
    editor.setSelectedWindowDedicated(dedicated)
    editor.message(dedicated ? "Window is now dedicated" : "Window is no longer dedicated")
  }, "Jemacs extension command that toggles whether the selected window is dedicated.")

  editor.command("quit-window", ({ editor, prefixArgument }) => {
    const bufferId = editor.currentBufferId
    editor.deleteWindow()
    if (prefixArgument != null) {
      editor.killBuffer(bufferId)
      return
    }
    if (listWindowLeaves(editor.windowLayout).length === 1) cycleBuffer(editor, 1)
  }, "Bury the current special buffer and select another buffer.")

  editor.command("window-configuration-to-register", async ({ editor, args }) => {
    const register = args[0] ?? await editor.prompt("Window configuration to register: ", "w", "register")
    if (!register) return
    editor.registers.set(register, editor.currentWindowConfiguration())
    editor.message(`Saved window configuration to register ${register}`)
  }, "Save the current window configuration to a register.")

  editor.command("tab-bar-new-tab", ({ editor, prefixArgument }) => newTab(editor, prefixArgument), "Create a new tab.")

  editor.command("tab-bar-close-tab", ({ editor, prefixArgument }) => closeTab(editor, prefixArgument), "Close the current tab.")

  editor.command("tab-bar-switch-to-next-tab", ({ editor, prefixArgument }) => switchTab(editor, prefixArgument ?? 1), "Switch to the next tab.")
  editor.command("tab-bar-switch-to-prev-tab", ({ editor, prefixArgument }) => switchTab(editor, -(prefixArgument ?? 1)), "Switch to the previous tab.")

  editor.command("next-buffer", ({ editor, prefixArgument }) => {
    const b = cycleBuffer(editor, prefixArgument ?? 1)
    editor.message(`Switched to ${editor.bufferDisplayName(b)}`)
  }, "Switch to the next buffer.")

  editor.command("previous-buffer", ({ editor, prefixArgument }) => {
    const b = cycleBuffer(editor, -(prefixArgument ?? 1))
    editor.message(`Switched to ${editor.bufferDisplayName(b)}`)
  }, "Switch to the previous buffer.")

  editor.command("switch-to-buffer", async ({ editor, args }) => {
    const defaultBuffer = editor.otherBuffer()
    const defaultName = defaultBuffer ? editor.bufferDisplayName(defaultBuffer) : ""
    const prompt = defaultName ? `Switch to buffer (default ${defaultName}): ` : "Switch to buffer: "
    const input = args[0] ?? await editor.completingRead(prompt, { collection: [...editor.buffers.values()].map(b => editor.bufferDisplayName(b)), history: "buffer" })
    const name = input || defaultName
    if (!name) return
    const buffer = editor.switchToBuffer(name)
    editor.message(`Switched to ${editor.bufferDisplayName(buffer)}`)
  }, "Prompt for a buffer name and switch to it.")

  editor.command("list-buffers", ({ editor, prefixArgument }) => {
    showBufferList(editor, { filesOnly: prefixArgument != null })
  }, "Display the buffer list.")

  editor.command("Buffer-menu-select", ({ buffer, editor }) => {
    const bufferId = bufferListEntryAtPoint(buffer)
    if (!bufferId) return
    const target = editor.buffers.get(bufferId)
    if (!target) return
    editor.switchToBuffer(target.id)
    editor.message(`Switched to ${editor.bufferDisplayName(target)}`)
  }, "Select this line's buffer in Buffer Menu.")

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
  editor.key("C-x left", "previous-buffer")
  editor.key("C-x C-left", "previous-buffer")
  editor.key("C-x right", "next-buffer")
  editor.key("C-x C-right", "next-buffer")
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
