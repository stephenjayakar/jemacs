/**
 * tab-bar.el: window-configuration tabs, plus the tab bar that draws them.
 *
 * A tab is a *named window configuration*, not a buffer: switching tabs
 * restores the whole window layout the tab was left in. The kernel owns the
 * state (`FrameRecord.tabs`, `Editor.selectTab`), `src/display/tab-bar.ts`
 * draws the bar, and this module owns the commands and the customs.
 *
 * Behaviour was captured from `emacs -Q --batch` on GNU Emacs 30.2 and is
 * asserted against that transcript in `test/plugins/tab-bar.test.ts`.
 */
import type { Editor } from "../src/kernel/editor"
import type { TabRecord } from "../src/kernel/frame"
import { createPluginContext, type PluginContext } from "../src/runtime/plugin-context"
import { defcustom, getCustom, getCustomVariable } from "../src/runtime/custom"
import { defface } from "../src/runtime/faces"
import { TAB_BAR_MODE, tabBarModeEnabled } from "../src/display/tab-bar"

// --- customs ---------------------------------------------------------------

defcustom("tab-bar-show", { kind: "choice", options: [
  { const: true, tag: "Always" },
  { const: false, tag: "Never" },
  { type: "natnum", tag: "Show if more tabs than this" },
] }, true as boolean | number,
  "Defines when to show the tab bar.\nIf t, enable `tab-bar-mode' automatically upon using the commands that\ncreate new window configurations (e.g. `tab-new').\nIf a non-negative integer, show the tab bar only if the number of the tabs\nexceeds the value of this variable.\nIf nil, always keep the tab bar hidden.", "tab-bar")

defcustom("tab-bar-new-tab-to", { kind: "choice", options: [
  { const: "leftmost", tag: "First tab" },
  { const: "left", tag: "To the left of the current tab" },
  { const: "right", tag: "To the right of the current tab" },
  { const: "rightmost", tag: "Last tab" },
] }, "right",
  "Where to create a new tab.", "tab-bar")

defcustom("tab-bar-new-tab-choice", { kind: "choice", options: [
  { const: true, tag: "Current buffer" },
  { const: "clone", tag: "Duplicate the current tab" },
  { const: "window", tag: "Current window" },
  { type: "string", tag: "Buffer name" },
] }, true as boolean | string,
  "Defines what to show in a new tab.\nIf t, start a new tab with the current buffer.\nIf `window', keep the selected window as a single window on the new tab.\nIf `clone', duplicate the contents of the tab that was active before.\nIf a string, use it as a buffer name to switch to.", "tab-bar")

defcustom("tab-bar-close-tab-select", { kind: "choice", options: [
  { const: "left", tag: "Select left tab" },
  { const: "right", tag: "Select right tab" },
  { const: "recent", tag: "Select recent tab" },
] }, "recent",
  "Which tab to make current after closing the specified tab.", "tab-bar")

defcustom("tab-bar-close-last-tab-choice", { kind: "choice", options: [
  { const: null, tag: "Do nothing and show message" },
  { const: "delete-frame", tag: "Close the containing frame" },
  { const: "tab-bar-mode-disable", tag: "Disable tab-bar-mode" },
] }, null as string | null,
  "What to do when the last tab is closed.", "tab-bar")

defcustom("tab-bar-tab-hints", "boolean", false,
  "Show absolute numbers on tabs in the tab bar before the tab name.", "tab-bar")

defcustom("tab-bar-close-button-show", { kind: "choice", options: [
  { const: true, tag: "On all tabs" },
  { const: "selected", tag: "On selected tab only" },
  { const: "non-selected", tag: "On non-selected tabs only" },
  { const: false, tag: "None" },
] }, true as boolean | string,
  "Defines where to show the close tab button.", "tab-bar")

defcustom("tab-bar-new-button-show", "boolean", true,
  "If non-nil, show the \"New tab\" button in the tab bar.", "tab-bar")

defcustom("tab-bar-separator", "string", "|",
  "String that delimits tabs.", "tab-bar")

defcustom("tab-bar-close-button", "string", " x",
  "Button for closing the clicked tab.", "tab-bar")

defcustom("tab-bar-new-button", "string", " + ",
  "Button for creating a new tab.", "tab-bar")

// --- faces -----------------------------------------------------------------
//
// Declared here as tab-bar.el declares them, so Customize lists them with
// documentation. The colours come from the theme (`src/themes/jemacs-dark.ts`),
// which is what `installDefaultFaces` installs as their baseline spec.

defface("tab-bar", {}, "Tab bar face.", "tab-bar")
defface("tab-bar-tab", { inherit: ["tab-bar"] },
  "Tab bar face for the selected tab.", "tab-bar")
defface("tab-bar-tab-inactive", { inherit: ["tab-bar-tab"] },
  "Tab bar face for non-selected tabs.", "tab-bar")

// --- helpers ---------------------------------------------------------------

const tabs = (editor: Editor): TabRecord[] => editor.selectedFrame.tabs
const currentIndex = (editor: Editor): number => editor.selectedFrame.selectedTab

/** Emacs `prefix-numeric-value` for the commands taking `(interactive "p")`. */
const numericArg = (prefixArgument: number | null, fallback = 1): number =>
  prefixArgument ?? fallback

/**
 * TAB-NUMBER for the commands that take one.
 *
 * In Emacs these are ordinary arguments and the prefix argument is only how
 * `(interactive "P")` supplies them, so a caller (the tab bar's own mouse
 * bindings, or `M-x` with args) can pass the number directly.
 */
function tabNumberArg(args: string[], prefixArgument: number | null): number | null {
  const explicit = args[0] != null ? Number.parseInt(args[0], 10) : Number.NaN
  return Number.isFinite(explicit) ? explicit : prefixArgument
}

/** Emacs `tab-bar--tab-index-recent`: index of the NTH most recently left tab. */
function recentTabIndex(editor: Editor, nth: number): number | null {
  const list = tabs(editor)
  const others = list
    .map((tab, index) => ({ tab, index }))
    .filter(entry => entry.index !== currentIndex(editor))
    .sort((a, b) => b.tab.time - a.tab.time)
  return others[nth - 1]?.index ?? null
}

/** Emacs `tab-bar--update-tab-bar-lines`: `tab-bar-show` t auto-enables the mode. */
function autoEnableTabBar(editor: Editor): void {
  if (getCustom<boolean | number>("tab-bar-show") !== true) return
  if (!tabBarModeEnabled(editor)) editor.enableMinorMode(TAB_BAR_MODE)
}

// --- commands --------------------------------------------------------------

/** Emacs `tab-bar-new-tab-to`: insert a new tab at an absolute position. */
function newTabTo(editor: Editor, tabNumber: number | null): void {
  const list = tabs(editor)
  const fromIndex = currentIndex(editor)
  const choice = getCustom<boolean | string>("tab-bar-new-tab-choice")

  // Emacs snapshots the departing tab *before* touching the windows and writes
  // that snapshot back at `(setf (nth from-index tabs) from-tab)`. Capturing
  // afterwards instead would store the collapsed single-window layout, and
  // returning to the tab would silently lose its splits.
  editor.captureSelectedTab()
  const fromTab = list[fromIndex]
  const fromConfig = fromTab?.config

  // `tab-bar-new-tab-choice` decides what the new tab shows. `clone` keeps the
  // current layout; anything else collapses to a single window, as Emacs's
  // `delete-other-windows` does.
  if (choice !== false && choice !== "clone") {
    editor.deleteOtherWindows()
    if (typeof choice === "string" && choice !== "window") editor.switchToBuffer(choice)
  }

  const toIndex = tabNumber != null
    ? (tabNumber < 0 ? list.length + 1 + tabNumber : tabNumber - 1)
    : newTabPosition(fromIndex, list.length)
  const clamped = Math.max(0, Math.min(toIndex, list.length))
  list.splice(clamped, 0, editor.makeTabFromCurrent())
  if (fromTab) fromTab.config = fromConfig
  // The new tab's configuration is already the live one, so selecting it is a
  // plain index move: routing through `selectTab` would re-capture the
  // departing tab and undo the snapshot restored just above.
  editor.selectedFrame.selectedTab = clamped
  autoEnableTabBar(editor)
  if (!tabBarModeEnabled(editor)) editor.message(`Added new tab at ${getCustom<string>("tab-bar-new-tab-to")}`)
  void editor.changed("tab-bar-new-tab")
}

function newTabPosition(fromIndex: number, count: number): number {
  switch (getCustom<string>("tab-bar-new-tab-to")) {
    case "leftmost": return 0
    case "rightmost": return count
    case "left": return fromIndex
    default: return fromIndex + 1
  }
}

/** Emacs `tab-bar-close-tab`. */
function closeTab(editor: Editor, tabNumber: number | null, toNumber: number | null = null): void {
  const frame = editor.selectedFrame
  const list = frame.tabs
  const current = frame.selectedTab
  const closeIndex = tabNumber != null ? tabNumber - 1 : current
  if (closeIndex < 0 || closeIndex >= list.length) return

  if (list.length === 1) {
    switch (getCustom<string | null>("tab-bar-close-last-tab-choice")) {
      case "delete-frame":
        editor.deleteFrame()
        return
      case "tab-bar-mode-disable":
        editor.disableMinorMode(TAB_BAR_MODE)
        return
      default:
        editor.message("Attempt to delete the sole tab in a frame")
        return
    }
  }

  if (closeIndex === current) {
    // Emacs selects the replacement tab *before* deleting the current one, so
    // the departing layout is saved and the arriving one is restored.
    const toIndex = toNumber != null ? toNumber - 1 : closeSelectIndex(editor, current, list.length)
    editor.selectTab(Math.max(0, Math.min(toIndex, list.length - 1)))
  }
  const [removed] = list.splice(closeIndex, 1)
  if (removed) editor.closedTabs.unshift({ frameId: frame.id, index: closeIndex, tab: removed })
  if (closeIndex < frame.selectedTab) frame.selectedTab--
  if (!tabBarModeEnabled(editor)) {
    editor.message(`Deleted tab and switched to ${getCustom<string>("tab-bar-close-tab-select")}`)
  }
  void editor.changed("tab-bar-close-tab")
}

function closeSelectIndex(editor: Editor, current: number, count: number): number {
  switch (getCustom<string>("tab-bar-close-tab-select")) {
    case "left": return current < 1 ? 1 : current - 1
    case "right": return count > current + 1 ? current + 1 : current - 1
    default: return recentTabIndex(editor, 1) ?? Math.max(0, current - 1)
  }
}

/** Emacs `tab-bar-move-tab-to`: move a tab to an absolute position. */
function moveTabTo(editor: Editor, toNumber: number, fromNumber: number | null): void {
  const frame = editor.selectedFrame
  const list = frame.tabs
  const fromIndex = (fromNumber ?? frame.selectedTab + 1) - 1
  if (fromIndex < 0 || fromIndex >= list.length) return
  const resolved = toNumber < 0 ? list.length + 1 + toNumber : toNumber
  const toIndex = Math.max(0, Math.min(resolved - 1, list.length - 1))
  const [moved] = list.splice(fromIndex, 1)
  if (!moved) return
  list.splice(toIndex, 0, moved)
  // Selection follows the tab it was on, wherever that tab landed.
  if (frame.selectedTab === fromIndex) frame.selectedTab = toIndex
  else {
    if (fromIndex < frame.selectedTab) frame.selectedTab--
    if (toIndex <= frame.selectedTab) frame.selectedTab++
  }
  void editor.changed("tab-bar-move-tab")
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  ctx.minorMode({
    name: TAB_BAR_MODE,
    global: true,
    // Emacs shows no mode-line indicator for `tab-bar-mode`: the bar itself is
    // the indicator. An absent lighter would print the mode's name instead.
    lighter: "",
    onEnable: ed => void ed.changed("tab-bar-mode"),
    onDisable: ed => void ed.changed("tab-bar-mode"),
  })

  ctx.command("tab-bar-new-tab-to", ({ editor, args, prefixArgument }) => {
    newTabTo(editor, tabNumberArg(args, prefixArgument))
  }, "Add a new tab at the absolute position TAB-NUMBER.")

  ctx.command("tab-bar-new-tab", ({ editor, prefixArgument }) => {
    // Relative addressing: `C-u 2 tab-new` inserts two positions to the right.
    if (prefixArgument == null) newTabTo(editor, null)
    else newTabTo(editor, currentIndex(editor) + prefixArgument + 1)
  }, "Create a new tab.")

  ctx.command("tab-bar-duplicate-tab", ({ editor, prefixArgument }) => {
    // Emacs `let'-binds `tab-bar-new-tab-choice' to `clone' for the duration,
    // which is what keeps the current window layout in the new tab.
    const variable = getCustomVariable("tab-bar-new-tab-choice")!
    const previous = variable.value
    variable.value = "clone"
    try {
      if (prefixArgument == null) newTabTo(editor, null)
      else newTabTo(editor, currentIndex(editor) + prefixArgument + 1)
    } finally {
      variable.value = previous
    }
  }, "Clone the current tab to ARG positions to the right.")

  ctx.command("tab-bar-close-tab", ({ editor, args, prefixArgument }) => {
    closeTab(editor, tabNumberArg(args, prefixArgument))
  }, "Close the tab specified by its absolute position TAB-NUMBER.")

  ctx.command("tab-bar-close-tab-by-name", async ({ editor, args }) => {
    const name = args[0] ?? await editor.completingRead("Close tab by name: ", {
      collection: tabs(editor).map(tab => editor.tabName(tab)),
      history: "tab-name",
    })
    if (!name) return
    const index = tabs(editor).findIndex(tab => editor.tabName(tab) === name)
    if (index === -1) return
    closeTab(editor, index + 1)
  }, "Close the tab given its NAME.")

  ctx.command("tab-bar-close-other-tabs", ({ editor, prefixArgument }) => {
    const frame = editor.selectedFrame
    const keepIndex = prefixArgument != null
      ? Math.max(1, Math.min(prefixArgument, frame.tabs.length)) - 1
      : frame.selectedTab
    if (!frame.tabs[keepIndex]) return
    if (keepIndex !== frame.selectedTab) editor.selectTab(keepIndex)
    const kept = frame.tabs[frame.selectedTab]!
    frame.tabs.forEach((tab, index) => {
      if (tab !== kept) editor.closedTabs.unshift({ frameId: frame.id, index, tab })
    })
    frame.tabs.length = 0
    frame.tabs.push(kept)
    frame.selectedTab = 0
    if (!tabBarModeEnabled(editor)) editor.message("Deleted all other tabs")
    void editor.changed("tab-bar-close-other-tabs")
  }, "Close all tabs on the selected frame, except the tab TAB-NUMBER.")

  ctx.command("tab-bar-undo-close-tab", ({ editor }) => {
    // Entries for deleted frames are dropped by `deleteFrame`, so anything
    // still on the list belongs to a live frame.
    const closed = editor.closedTabs.shift()
    if (!closed) {
      editor.message("No more closed tabs to undo")
      return
    }
    if (closed.frameId !== editor.selectedFrameId) editor.selectFrame(closed.frameId)
    const frame = editor.selectedFrame
    const index = Math.max(0, Math.min(closed.index, frame.tabs.length))
    frame.tabs.splice(index, 0, closed.tab)
    if (index <= frame.selectedTab) frame.selectedTab++
    editor.selectTab(index)
    void editor.changed("tab-bar-undo-close-tab")
  }, "Restore the most recently closed tab.")

  ctx.command("tab-bar-select-tab", ({ editor, args, prefixArgument }) => {
    const list = tabs(editor)
    const requested = tabNumberArg(args, prefixArgument) ?? 0
    const toNumber = requested < 0
      ? list.length + 1 + requested
      : requested === 0 ? currentIndex(editor) + 1 : requested
    editor.selectTab(Math.max(1, Math.min(toNumber, list.length)) - 1)
  }, "Switch to the tab by its absolute position TAB-NUMBER in the tab bar.")

  ctx.command("tab-bar-switch-to-next-tab", ({ editor, prefixArgument }) => {
    const list = tabs(editor)
    if (!list.length) return
    const arg = numericArg(prefixArgument)
    const to = ((currentIndex(editor) + arg) % list.length + list.length) % list.length
    editor.selectTab(to)
  }, "Switch to ARGth next tab.")

  ctx.command("tab-bar-switch-to-prev-tab", ({ editor, prefixArgument }) => {
    const list = tabs(editor)
    if (!list.length) return
    const arg = -numericArg(prefixArgument)
    const to = ((currentIndex(editor) + arg) % list.length + list.length) % list.length
    editor.selectTab(to)
  }, "Switch to ARGth previous tab.")

  ctx.command("tab-bar-switch-to-last-tab", ({ editor, prefixArgument }) => {
    const list = tabs(editor)
    editor.selectTab(Math.max(0, list.length - Math.abs(numericArg(prefixArgument))))
  }, "Switch to the last tab or ARGth tab from the end of the tab bar.")

  ctx.command("tab-bar-switch-to-recent-tab", ({ editor, prefixArgument }) => {
    const index = recentTabIndex(editor, numericArg(prefixArgument))
    if (index == null) {
      editor.message("No more recent tabs")
      return
    }
    editor.selectTab(index)
  }, "Switch to ARGth most recently visited tab.")

  ctx.command("tab-bar-switch-to-tab", async ({ editor, args }) => {
    const name = args[0] ?? await editor.completingRead("Switch to tab by name: ", {
      collection: tabs(editor).map(tab => editor.tabName(tab)),
      history: "tab-name",
    })
    if (!name) return
    const index = tabs(editor).findIndex(tab => editor.tabName(tab) === name)
    // Emacs creates and renames a tab when no tab carries that name.
    if (index === -1) {
      newTabTo(editor, null)
      renameTab(editor, name, null)
      return
    }
    editor.selectTab(index)
  }, "Switch to the tab by NAME.")

  ctx.command("tab-bar-rename-tab", async ({ editor, args, prefixArgument }) => {
    const list = tabs(editor)
    const index = prefixArgument != null
      ? Math.max(0, Math.min(prefixArgument, list.length)) - 1
      : currentIndex(editor)
    const target = list[index]
    if (!target) return
    const name = args[0] ?? await editor.prompt(
      "New name for tab (leave blank for automatic naming): ",
      editor.tabName(target),
      "tab-name",
    )
    if (name == null) return
    renameTab(editor, name, index)
  }, "Give the tab specified by its absolute position TAB-NUMBER a new NAME.")

  ctx.command("tab-bar-rename-tab-by-name", async ({ editor, args }) => {
    const oldName = args[0] ?? await editor.completingRead("Rename tab by name: ", {
      collection: tabs(editor).map(tab => editor.tabName(tab)),
      history: "tab-name",
    })
    if (!oldName) return
    const index = tabs(editor).findIndex(tab => editor.tabName(tab) === oldName)
    if (index === -1) return
    const name = args[1] ?? await editor.prompt(
      "New name for tab (leave blank for automatic naming): ",
      oldName,
      "tab-name",
    )
    if (name == null) return
    renameTab(editor, name, index)
  }, "Rename the tab named TAB-NAME to NEW-NAME.")

  ctx.command("tab-bar-move-tab-to", ({ editor, prefixArgument }) => {
    moveTabTo(editor, prefixArgument ?? 1, null)
  }, "Move the current tab to the absolute position TO-NUMBER.")

  ctx.command("tab-bar-move-tab", ({ editor, prefixArgument }) => {
    const list = tabs(editor)
    if (!list.length) return
    const from = currentIndex(editor)
    const to = ((from + numericArg(prefixArgument)) % list.length + list.length) % list.length
    moveTabTo(editor, to + 1, from + 1)
  }, "Move the current tab ARG positions to the right.")

  ctx.command("tab-bar-move-tab-backward", ({ editor, prefixArgument }) => {
    const list = tabs(editor)
    if (!list.length) return
    const from = currentIndex(editor)
    const to = ((from - numericArg(prefixArgument)) % list.length + list.length) % list.length
    moveTabTo(editor, to + 1, from + 1)
  }, "Move the current tab ARG positions to the left.")

  ctx.command("switch-to-buffer-other-tab", async ({ editor, args }) => {
    const name = args[0] ?? await editor.completingRead("Switch to buffer in other tab: ", {
      collection: [...editor.buffers.values()].map(b => editor.bufferDisplayName(b)),
      history: "buffer",
    })
    if (!name) return
    newTabTo(editor, null)
    editor.switchToBuffer(name)
  }, "Switch to a buffer in another tab.")

  ctx.command("find-file-other-tab", async ({ editor, args }) => {
    const input = args[0] ?? await editor.completingRead("Find file in other tab: ", {
      completion: "file",
      history: "file",
    })
    if (!input) return
    newTabTo(editor, null)
    const buffer = await editor.openFile(input)
    editor.message(`Now visiting ${editor.bufferDisplayName(buffer)} in other tab`)
  }, "Find a file in another tab.")

  // Emacs aliases: the `tab-*' names are what `C-x t' is documented with.
  const aliases: Array<[string, string]> = [
    ["tab-new", "tab-bar-new-tab"],
    ["tab-new-to", "tab-bar-new-tab-to"],
    ["tab-duplicate", "tab-bar-duplicate-tab"],
    ["tab-close", "tab-bar-close-tab"],
    ["tab-close-other", "tab-bar-close-other-tabs"],
    ["tab-undo", "tab-bar-undo-close-tab"],
    ["tab-select", "tab-bar-select-tab"],
    ["tab-switch", "tab-bar-switch-to-tab"],
    ["tab-next", "tab-bar-switch-to-next-tab"],
    ["tab-previous", "tab-bar-switch-to-prev-tab"],
    ["tab-last", "tab-bar-switch-to-last-tab"],
    ["tab-recent", "tab-bar-switch-to-recent-tab"],
    ["tab-move", "tab-bar-move-tab"],
    ["tab-move-to", "tab-bar-move-tab-to"],
    ["tab-rename", "tab-bar-rename-tab"],
    ["tab-bar-select-tab-by-name", "tab-bar-switch-to-tab"],
  ]
  for (const [alias, target] of aliases) {
    const spec = editor.commands.get(target)!
    ctx.command(alias, spec.fn, spec.description)
  }

  // `tab-prefix-map`, i.e. GNU Emacs `C-x t ...`.
  ctx.key("global-map", "C-x t 2", "tab-new")
  ctx.key("global-map", "C-x t N", "tab-new-to")
  ctx.key("global-map", "C-x t n", "tab-duplicate")
  ctx.key("global-map", "C-x t 1", "tab-close-other")
  ctx.key("global-map", "C-x t 0", "tab-close")
  ctx.key("global-map", "C-x t u", "tab-undo")
  ctx.key("global-map", "C-x t o", "tab-next")
  ctx.key("global-map", "C-x t O", "tab-previous")
  ctx.key("global-map", "C-x t m", "tab-move")
  ctx.key("global-map", "C-x t M", "tab-move-to")
  ctx.key("global-map", "C-x t r", "tab-rename")
  ctx.key("global-map", "C-x t RET", "tab-switch")
  ctx.key("global-map", "C-x t return", "tab-switch")
  ctx.key("global-map", "C-x t b", "switch-to-buffer-other-tab")
  ctx.key("global-map", "C-x t f", "find-file-other-tab")
  ctx.key("global-map", "C-x t C-f", "find-file-other-tab")
}

/** Emacs `tab-bar-rename-tab`: an empty NAME restores automatic naming. */
function renameTab(editor: Editor, name: string, index: number | null): void {
  const list = tabs(editor)
  const target = list[index ?? currentIndex(editor)]
  if (!target) return
  target.explicitName = name.length > 0
  target.name = name.length > 0 ? name : editor.bufferDisplayName(target.bufferId)
  if (!tabBarModeEnabled(editor)) editor.message(`Renamed tab to '${target.name}'`)
  void editor.changed("tab-bar-rename-tab")
}

