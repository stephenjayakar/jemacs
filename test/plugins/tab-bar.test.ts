/**
 * tab-bar parity tests.
 *
 * Every expectation below is the literal output of GNU Emacs 30.2 under
 * `emacs -Q --batch`, driving `tab-bar.el` through the same command sequence.
 * The reference transcript, reproduced here so a reader need not rerun Emacs:
 *
 *   setup                          ("a" "b" "c") sel=0 buf=a
 *   sel2 new-tab (default)         ("a" "b" "b" "c") sel=2 buf=b
 *   sel2 new-tab 2                 ("a" "b" "c" "b") sel=3 buf=b
 *   sel2 new-tab -1                ("b" "a" "b" "c") sel=0 buf=b
 *   sel2 new-tab 0                 ("a" "b" "b" "c") sel=1 buf=b
 *   sel2 close-tab (recent)        ("a" "c") sel=0 buf=a
 *   visit1,3,2 close cur           ("a" "c") sel=1 buf=c
 *   sel1 close-tab 2               ("a" "c") sel=0 buf=a
 *   sel3 close-tab 2               ("a" "c") sel=1 buf=c
 *   sel1 next 2                    ("a" "b" "c") sel=2 buf=c
 *   sel1 next 4                    ("a" "b" "c") sel=1 buf=b
 *   sel2 next 0                    ("a" "b" "c") sel=1 buf=b
 *   sel3 prev 2                    ("a" "b" "c") sel=0 buf=a
 *   sel3 prev -1                   ("a" "b" "c") sel=0 buf=a
 *   sel2 move-tab 1                ("a" "c" "b") sel=2 buf=b
 *   sel2 move-tab -1               ("b" "a" "c") sel=0 buf=b
 *   sel1 close-other               ("a") sel=0 buf=a
 *   close then undo                ("a" "b" "c") sel=1 buf=b
 *   rename zed                     ("a" "zed" "c") sel=1 buf=b
 *   rename then switch buf         ("a" "zed" "c") sel=1 buf=a
 *   no rename, switch buf          ("a" "a" "c") sel=1 buf=a
 *   duplicate                      ("a" "b" "b" "c") sel=2 buf=b
 *   recent from 3                  ("a" "b" "c") sel=0 buf=a
 *   last                           ("a" "b" "c") sel=2 buf=c
 *   windows after return to split tab: 2
 *   windows in new tab: 1
 *   close sole tab: (user-error "Attempt to delete the sole tab in a frame")
 *
 * Bar rendering, from the same Emacs:
 *   one tab      "|a x| + "
 *   two tabs     "|a x|bbb x| + "
 *   hints        "|1 a x|2 bbb x| + "
 *   no close     "|a|bbb| + "
 */
import { beforeEach, describe, expect, test } from "bun:test"
import { Editor } from "../../src/kernel/editor"
import { installDefaultConfig } from "../../src/config"
import { listWindowLeaves } from "../../src/kernel/window"
import { tabBarLayout, tabBarHitTest, tabBarVisible } from "../../src/display/tab-bar"
import { getCustomVariable } from "../../src/runtime/custom"

function makeEditor(): Editor {
  const editor = new Editor()
  installDefaultConfig(editor)
  return editor
}

/** Three tabs showing buffers a, b, c, with tab 1 selected \u2014 the Emacs `setup`. */
async function setup(): Promise<Editor> {
  const editor = makeEditor()
  editor.scratch("a", "a", "text")
  await editor.run("tab-new")
  editor.scratch("b", "b", "text")
  await editor.run("tab-new")
  editor.scratch("c", "c", "text")
  editor.selectTab(0)
  return editor
}

const names = (editor: Editor): string[] => editor.tabs.map(tab => editor.tabName(tab))
const state = (editor: Editor) => ({
  names: names(editor),
  sel: editor.selectedTab,
  buf: editor.currentBuffer.name,
})

/** Emacs `C-u N CMD`. */
async function withPrefix(editor: Editor, digits: number, command: string, negative = false): Promise<void> {
  if (negative) editor.prefixArg.toggleNegative()
  if (digits >= 0) editor.prefixArg.addDigit(digits)
  await editor.run(command)
}

/** Restore a `defcustom` after a test mutates it. */
function setCustom(name: string, value: unknown): void {
  getCustomVariable(name)!.value = value
}

describe("tab-bar state", () => {
  test("setup produces three tabs named after their buffers", async () => {
    const editor = await setup()
    expect(state(editor)).toEqual({ names: ["a", "b", "c"], sel: 0, buf: "a" })
  })

  test("a fresh editor starts with exactly one tab", () => {
    const editor = makeEditor()
    expect(names(editor)).toEqual(["*scratch*"])
    expect(editor.selectedTab).toBe(0)
  })
})

describe("tab-bar-new-tab", () => {
  test("adds the new tab to the right of the current one", async () => {
    const editor = await setup()
    editor.selectTab(1)
    await editor.run("tab-new")
    expect(state(editor)).toEqual({ names: ["a", "b", "b", "c"], sel: 2, buf: "b" })
  })

  test("a positive prefix is a relative position", async () => {
    const editor = await setup()
    editor.selectTab(1)
    await withPrefix(editor, 2, "tab-new")
    expect(state(editor)).toEqual({ names: ["a", "b", "c", "b"], sel: 3, buf: "b" })
  })

  test("a negative prefix moves the new tab left", async () => {
    const editor = await setup()
    editor.selectTab(1)
    await withPrefix(editor, -1, "tab-new", true)
    expect(state(editor)).toEqual({ names: ["b", "a", "b", "c"], sel: 0, buf: "b" })
  })

  test("a zero prefix creates the tab in place of the current one", async () => {
    const editor = await setup()
    editor.selectTab(1)
    await withPrefix(editor, 0, "tab-new")
    expect(state(editor)).toEqual({ names: ["a", "b", "b", "c"], sel: 1, buf: "b" })
  })

  test("tab-bar-new-tab-to leftmost and rightmost place the tab at an end", async () => {
    const editor = await setup()
    editor.selectTab(1)
    setCustom("tab-bar-new-tab-to", "leftmost")
    try {
      await editor.run("tab-new")
      expect(editor.selectedTab).toBe(0)
      setCustom("tab-bar-new-tab-to", "rightmost")
      await editor.run("tab-new")
      expect(editor.selectedTab).toBe(editor.tabs.length - 1)
    } finally {
      setCustom("tab-bar-new-tab-to", "right")
    }
  })

  test("the new tab starts as a single window, and returning restores the split", async () => {
    const editor = await setup()
    await editor.run("split-window-below")
    expect(listWindowLeaves(editor.windowLayout)).toHaveLength(2)
    await editor.run("tab-new")
    // Emacs: "windows in new tab: 1".
    expect(listWindowLeaves(editor.windowLayout)).toHaveLength(1)
    editor.selectTab(0)
    // Emacs: "windows after return to split tab: 2".
    expect(listWindowLeaves(editor.windowLayout)).toHaveLength(2)
  })
})

describe("tab-bar-duplicate-tab", () => {
  test("clones the current tab, keeping its window layout", async () => {
    const editor = await setup()
    editor.selectTab(1)
    await editor.run("split-window-below")
    await editor.run("tab-duplicate")
    expect(state(editor)).toEqual({ names: ["a", "b", "b", "c"], sel: 2, buf: "b" })
    expect(listWindowLeaves(editor.windowLayout)).toHaveLength(2)
  })
})

describe("tab-bar-close-tab", () => {
  test("closing the current tab selects the most recent one", async () => {
    const editor = await setup()
    editor.selectTab(1)
    await editor.run("tab-close")
    expect(state(editor)).toEqual({ names: ["a", "c"], sel: 0, buf: "a" })
  })

  test("`recent` follows the visit order, not the position", async () => {
    const editor = await setup()
    editor.selectTab(0)
    editor.selectTab(2)
    editor.selectTab(1)
    await editor.run("tab-close")
    expect(state(editor)).toEqual({ names: ["a", "c"], sel: 1, buf: "c" })
  })

  test("a numeric prefix closes that absolute tab and keeps the selection", async () => {
    const editor = await setup()
    editor.selectTab(0)
    await withPrefix(editor, 2, "tab-close")
    expect(state(editor)).toEqual({ names: ["a", "c"], sel: 0, buf: "a" })
  })

  test("closing a preceding tab shifts the selection down", async () => {
    const editor = await setup()
    editor.selectTab(2)
    await withPrefix(editor, 2, "tab-close")
    expect(state(editor)).toEqual({ names: ["a", "c"], sel: 1, buf: "c" })
  })

  test("an out-of-range prefix closes nothing", async () => {
    const editor = await setup()
    editor.selectTab(1)
    await withPrefix(editor, 9, "tab-close")
    expect(state(editor)).toEqual({ names: ["a", "b", "c"], sel: 1, buf: "b" })
  })

  test("tab-bar-close-tab-select left and right pick the neighbour", async () => {
    setCustom("tab-bar-close-tab-select", "left")
    try {
      const editor = await setup()
      editor.selectTab(1)
      await editor.run("tab-close")
      expect(state(editor)).toEqual({ names: ["a", "c"], sel: 0, buf: "a" })
      setCustom("tab-bar-close-tab-select", "right")
      const other = await setup()
      other.selectTab(1)
      await other.run("tab-close")
      expect(state(other)).toEqual({ names: ["a", "c"], sel: 1, buf: "c" })
    } finally {
      setCustom("tab-bar-close-tab-select", "recent")
    }
  })

  test("closing the sole tab reports an error instead of deleting it", async () => {
    const editor = await setup()
    const messages: string[] = []
    editor.events.on("message", ({ text }) => { messages.push(text) })
    editor.selectTab(0)
    await editor.run("tab-close")
    await editor.run("tab-close")
    expect(editor.tabs).toHaveLength(1)
    await editor.run("tab-close")
    expect(editor.tabs).toHaveLength(1)
    expect(messages).toContain("Attempt to delete the sole tab in a frame")
  })

  test("tab-bar-close-last-tab-choice delete-frame closes the frame instead", async () => {
    setCustom("tab-bar-close-last-tab-choice", "delete-frame")
    try {
      const editor = makeEditor()
      await editor.run("make-frame-command")
      expect(editor.frames).toHaveLength(2)
      await editor.run("tab-close")
      expect(editor.frames).toHaveLength(1)
    } finally {
      setCustom("tab-bar-close-last-tab-choice", null)
    }
  })
})

describe("tab-bar-close-other-tabs", () => {
  test("keeps only the current tab", async () => {
    const editor = await setup()
    editor.selectTab(0)
    await editor.run("tab-close-other")
    expect(state(editor)).toEqual({ names: ["a"], sel: 0, buf: "a" })
  })
})

describe("tab-bar-undo-close-tab", () => {
  test("restores the closed tab at its original position", async () => {
    const editor = await setup()
    editor.selectTab(1)
    await editor.run("tab-close")
    await editor.run("tab-undo")
    expect(state(editor)).toEqual({ names: ["a", "b", "c"], sel: 1, buf: "b" })
  })

  test("reports when there is nothing to restore", async () => {
    const editor = await setup()
    const messages: string[] = []
    editor.events.on("message", ({ text }) => { messages.push(text) })
    await editor.run("tab-undo")
    expect(messages).toContain("No more closed tabs to undo")
  })
})

describe("tab switching", () => {
  test("next honors a positive prefix and wraps", async () => {
    const editor = await setup()
    await withPrefix(editor, 2, "tab-next")
    expect(state(editor)).toEqual({ names: ["a", "b", "c"], sel: 2, buf: "c" })

    editor.selectTab(0)
    await withPrefix(editor, 4, "tab-next")
    expect(state(editor)).toEqual({ names: ["a", "b", "c"], sel: 1, buf: "b" })
  })

  test("next with a zero prefix keeps the selected tab", async () => {
    const editor = await setup()
    editor.selectTab(1)
    await withPrefix(editor, 0, "tab-next")
    expect(state(editor)).toEqual({ names: ["a", "b", "c"], sel: 1, buf: "b" })
  })

  test("prev honors positive and negative prefixes", async () => {
    const editor = await setup()
    editor.selectTab(2)
    await withPrefix(editor, 2, "tab-previous")
    expect(state(editor)).toEqual({ names: ["a", "b", "c"], sel: 0, buf: "a" })

    editor.selectTab(2)
    await withPrefix(editor, -1, "tab-previous", true)
    expect(state(editor)).toEqual({ names: ["a", "b", "c"], sel: 0, buf: "a" })
  })

  test("last selects the rightmost tab", async () => {
    const editor = await setup()
    editor.selectTab(1)
    await editor.run("tab-last")
    expect(state(editor)).toEqual({ names: ["a", "b", "c"], sel: 2, buf: "c" })
  })

  test("recent returns to the previously selected tab", async () => {
    const editor = await setup()
    editor.selectTab(2)
    await editor.run("tab-recent")
    expect(state(editor)).toEqual({ names: ["a", "b", "c"], sel: 0, buf: "a" })
  })

  test("select-tab takes an absolute number, and a negative counts from the end", async () => {
    const editor = await setup()
    await withPrefix(editor, 3, "tab-select")
    expect(editor.selectedTab).toBe(2)
    await withPrefix(editor, -1, "tab-select", true)
    expect(editor.selectedTab).toBe(2)
  })

  test("switch-to-tab selects an existing tab by name", async () => {
    const editor = await setup()
    await editor.run("tab-switch", ["c"])
    expect(state(editor)).toEqual({ names: ["a", "b", "c"], sel: 2, buf: "c" })
  })

  test("switch-to-tab creates and renames a tab when the name is unknown", async () => {
    const editor = await setup()
    await editor.run("tab-switch", ["nope"])
    expect(names(editor)).toEqual(["a", "nope", "b", "c"])
    expect(editor.selectedTab).toBe(1)
  })

  test("switching tabs restores each tab's own window layout", async () => {
    const editor = await setup()
    editor.selectTab(0)
    await editor.run("split-window-below")
    await editor.run("split-window-right")
    const split = listWindowLeaves(editor.windowLayout).length
    expect(split).toBe(3)
    editor.selectTab(1)
    expect(listWindowLeaves(editor.windowLayout)).toHaveLength(1)
    editor.selectTab(0)
    expect(listWindowLeaves(editor.windowLayout)).toHaveLength(split)
  })
})

describe("tab-bar-move-tab", () => {
  test("moves the current tab right and carries the selection", async () => {
    const editor = await setup()
    editor.selectTab(1)
    await withPrefix(editor, 1, "tab-move")
    expect(state(editor)).toEqual({ names: ["a", "c", "b"], sel: 2, buf: "b" })
  })

  test("a negative prefix wraps to the front", async () => {
    const editor = await setup()
    editor.selectTab(1)
    await withPrefix(editor, -1, "tab-move", true)
    expect(state(editor)).toEqual({ names: ["b", "a", "c"], sel: 0, buf: "b" })
  })
})

describe("tab-bar-rename-tab", () => {
  test("an explicit name survives a buffer switch", async () => {
    const editor = await setup()
    editor.selectTab(1)
    await editor.run("tab-rename", ["zed"])
    expect(state(editor)).toEqual({ names: ["a", "zed", "c"], sel: 1, buf: "b" })
    editor.switchToBuffer("a")
    expect(names(editor)).toEqual(["a", "zed", "c"])
  })

  test("without a rename, the tab name follows the current buffer", async () => {
    const editor = await setup()
    editor.selectTab(1)
    editor.switchToBuffer("a")
    expect(state(editor)).toEqual({ names: ["a", "a", "c"], sel: 1, buf: "a" })
  })

  test("an empty name restores automatic naming", async () => {
    const editor = await setup()
    editor.selectTab(1)
    await editor.run("tab-rename", ["zed"])
    await editor.run("tab-rename", [""])
    expect(names(editor)).toEqual(["a", "b", "c"])
  })
})

describe("tab-bar-mode and rendering", () => {
  beforeEach(() => {
    setCustom("tab-bar-show", true)
    setCustom("tab-bar-tab-hints", false)
    setCustom("tab-bar-close-button-show", true)
  })

  test("creating a tab turns tab-bar-mode on, as tab-bar-show t does in Emacs", async () => {
    const editor = makeEditor()
    expect(tabBarVisible(editor)).toBe(false)
    await editor.run("tab-new")
    expect(tabBarVisible(editor)).toBe(true)
  })

  test("the bar renders exactly as emacs -Q prints it", async () => {
    const editor = makeEditor()
    editor.scratch("a", "a", "text")
    // A new tab starts on the current buffer, so both tabs read "a" here.
    await editor.run("tab-new")
    expect(tabBarLayout(editor).text).toBe("|a x|a x| + ")

    editor.scratch("bbb", "bbb", "text")
    editor.selectTab(0)
    expect(tabBarLayout(editor).text).toBe("|a x|bbb x| + ")
  })

  test("tab-bar-tab-hints prefixes each tab with its number", async () => {
    const editor = makeEditor()
    editor.scratch("a", "a", "text")
    await editor.run("tab-new")
    editor.scratch("bbb", "bbb", "text")
    editor.selectTab(0)
    setCustom("tab-bar-tab-hints", true)
    expect(tabBarLayout(editor).text).toBe("|1 a x|2 bbb x| + ")
  })

  test("tab-bar-close-button-show nil drops the close buttons", async () => {
    const editor = makeEditor()
    editor.scratch("a", "a", "text")
    await editor.run("tab-new")
    editor.scratch("bbb", "bbb", "text")
    editor.selectTab(0)
    setCustom("tab-bar-close-button-show", false)
    expect(tabBarLayout(editor).text).toBe("|a|bbb| + ")
  })

  test("the selected tab carries tab-bar-tab and the others tab-bar-tab-inactive", async () => {
    const editor = makeEditor()
    editor.scratch("a", "a", "text")
    await editor.run("tab-new")
    editor.scratch("bbb", "bbb", "text")
    editor.selectTab(0)
    const { text, spans } = tabBarLayout(editor)
    // Emacs paints the whole row on `tab-bar` and layers the per-tab faces
    // over it, so the first span covers the bar and the rest are the tabs.
    expect(spans.map(span => [text.slice(span.start, span.end), span.face])).toEqual([
      ["|a x|bbb x| + ", "tab-bar"],
      ["a x", "tab-bar-tab"],
      ["bbb x", "tab-bar-tab-inactive"],
    ])
  })

  test("tab-bar-show 1 hides the bar until a second tab exists", async () => {
    const editor = makeEditor()
    await editor.run("tab-new")
    setCustom("tab-bar-show", 1)
    expect(tabBarVisible(editor)).toBe(true)
    await editor.run("tab-close")
    expect(tabBarVisible(editor)).toBe(false)
  })

  test("hit testing maps columns to the tab, its close button, and the new button", async () => {
    const editor = makeEditor()
    editor.scratch("a", "a", "text")
    await editor.run("tab-new")
    editor.scratch("bbb", "bbb", "text")
    editor.selectTab(0)
    // "|a x|bbb x| + "
    //  0123456789...
    expect(tabBarHitTest(editor, 0)).toBeNull()
    expect(tabBarHitTest(editor, 1)).toEqual({ kind: "select", index: 0 })
    expect(tabBarHitTest(editor, 3)).toEqual({ kind: "close", index: 0 })
    expect(tabBarHitTest(editor, 5)).toEqual({ kind: "select", index: 1 })
    expect(tabBarHitTest(editor, 12)).toEqual({ kind: "new" })
  })
})

describe("tabs and buffers", () => {
  test("killing a buffer clears it from every tab's saved layout", async () => {
    const editor = await setup()
    editor.selectTab(1)
    editor.selectTab(0)
    editor.killBuffer("b")
    expect(names(editor)).not.toContain("b")
    editor.selectTab(1)
    expect(editor.currentBuffer.name).not.toBe("b")
  })
})

describe("tabs and frames", () => {
  test("each frame owns its own tabs", async () => {
    const editor = await setup()
    expect(editor.tabs).toHaveLength(3)
    await editor.run("make-frame-command")
    expect(editor.tabs).toHaveLength(1)
    await editor.run("tab-new")
    expect(editor.tabs).toHaveLength(2)
    editor.selectFrame(editor.frames[0]!.id)
    expect(editor.tabs).toHaveLength(3)
  })
})
