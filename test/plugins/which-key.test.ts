import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { makeEditor } from "./helper"
import { keySeq } from "../harness/script"
import { install, bindingsUnder, describePrefix, describeTopLevelGlobalBindings, formatWhichKey, paginateWhichKey, showWhichKey, sortWhichKeyEntries } from "../../plugins/which-key"
import { setCustom } from "../../src/runtime/custom"
import type { Editor } from "../../src/kernel/editor"

let editor: Editor
let messages: string[]

beforeEach(() => {
  editor = makeEditor()
  install(editor)
  setCustom("which-key-idle-delay", 0.5)
  setCustom("which-key-separator", " → ")
  setCustom("which-key-sort-order", "key-order-alpha")
  setCustom("which-key-prefix-name-alist", [])
  messages = []
  editor.events.on("message", ({ text }) => { messages.push(text) })
})

afterEach(() => {
  if (editor.isMinorModeEnabled("which-key-mode")) {
    editor.disableMinorMode("which-key-mode")
  }
})

async function waitFor(pred: () => boolean, timeout = 1000): Promise<boolean> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise(r => setTimeout(r, 5))
  }
  return pred()
}

const lastMsg = () => messages[messages.length - 1] ?? ""

describe("describePrefix", () => {
  test("lists next-key entries under C-x from the global map", () => {
    const entries = describePrefix(editor, "C-x")
    const map = new Map(entries)
    expect(map.get("C-s")).toBe("save-buffer")
    expect(map.get("C-f")).toBe("find-file")
    expect(map.get("b")).toBe("switch-to-buffer")
    expect(map.get("o")).toBe("other-window")
  })

  test("collapses deeper sequences to a prefix group label", () => {
    const entries = describePrefix(editor, "C-x")
    const map = new Map(entries)
    expect(map.get("4")).toBe("+other-window")
  })

  test("expands a nested prefix on the second keystroke", () => {
    const entries = describePrefix(editor, "C-x 4")
    const map = new Map(entries)
    expect(map.get("f")).toBe("find-file-other-window")
    expect(map.get("b")).toBe("switch-to-buffer-other-window")
  })

  test("dedupes by lookup order so a minor-mode binding shadows global", () => {
    editor.key("C-c z", "keyboard-quit")
    editor.enableMinorMode("which-key-mode")
    editor.defineKey("which-key-mode", "C-c z", "save-buffer")
    const map = new Map(describePrefix(editor, "C-c"))
    expect(map.get("z")).toBe("save-buffer")
  })

  test("bindingsUnder returns full sequences, not next-keys", () => {
    const seqs = bindingsUnder(editor, "C-h").map(([s]) => s)
    expect(seqs).toContain("C-h b")
    expect(seqs).toContain("C-h k")
    expect(seqs.every(s => s.startsWith("C-h "))).toBe(true)
  })

  test("empty for an unknown prefix", () => {
    expect(describePrefix(editor, "C-q")).toEqual([])
  })

  test("sorts special keys first and prefix groups last", () => {
    const entries = sortWhichKeyEntries([
      ["z", "z-command"],
      ["a", "+prefix"],
      ["enter", "ret-command"],
      ["space", "space-command"],
      ["tab", "tab-command"],
      ["b", "b-command"],
    ])
    expect(entries.map(([k]) => k)).toEqual(["space", "tab", "enter", "b", "z", "a"])
  })

  test("supports description-order sorting", () => {
    setCustom("which-key-sort-order", "description-order")
    const entries = sortWhichKeyEntries([
      ["z", "zulu-command"],
      ["b", "alpha-command"],
      ["a", "+prefix"],
      ["c", "beta-command"],
    ])
    expect(entries.map(([k]) => k)).toEqual(["b", "c", "z", "a"])
  })

  test("renders named and unnamed prefix groups", () => {
    setCustom("which-key-prefix-name-alist", [["C-z a", "letters"]])
    editor.key("C-z a b", "cmd-b")
    editor.key("C-z c d", "cmd-d")
    const map = new Map(describePrefix(editor, "C-z"))
    expect(map.get("a")).toBe("+letters")
    expect(map.get("c")).toBe("+prefix")
  })

  test("describeTopLevelGlobalBindings lists non-prefix global bindings only", () => {
    editor.key("C-z", "top-command")
    editor.key("C-y a", "nested-command")
    const map = new Map(describeTopLevelGlobalBindings(editor))
    expect(map.get("C-z")).toBe("top-command")
    expect(map.has("C-y")).toBe(false)
    expect(map.has("C-y a")).toBe(false)
  })
})

describe("formatWhichKey", () => {
  test("renders prefix header and key→command pairs", () => {
    const out = formatWhichKey("C-x", [["C-f", "find-file"], ["b", "switch-to-buffer"]], " → ")
    expect(out).toBe("C-x-:  C-f → find-file  b → switch-to-buffer")
  })

  test("renders Emacs key descriptions for special keys", () => {
    const out = formatWhichKey("C-c", [["space", "set-mark-command"], ["tab", "indent"], ["enter", "newline"]], " → ")
    expect(out).toBe("C-c-:  SPC → set-mark-command  TAB → indent  RET → newline")
  })
})

describe("paginateWhichKey", () => {
  test("splits entries by echo-area width", () => {
    const entries: Array<[string, string]> = [
      ["a", "alpha-command"],
      ["b", "bravo-command"],
      ["c", "charlie-command"],
    ]
    expect(paginateWhichKey("C-z", entries, " → ", 34)).toEqual([
      [["a", "alpha-command"]],
      [["b", "bravo-command"]],
      [["c", "charlie-command"]],
    ])
  })
})

describe("which-key-mode", () => {
  test("toggle command enables and disables the mode", async () => {
    expect(editor.isMinorModeEnabled("which-key-mode")).toBe(false)
    await editor.run("which-key-mode")
    expect(editor.isMinorModeEnabled("which-key-mode")).toBe(true)
    await editor.run("which-key-mode")
    expect(editor.isMinorModeEnabled("which-key-mode")).toBe(false)
  })

  test("shows bindings in echo area after idle delay on a prefix key", async () => {
    await editor.run("which-key-mode")
    setCustom("which-key-idle-delay", 0.02)
    await keySeq(editor, "C-x")
    expect(editor.keymaps.pendingSequence()).toBe("C-x")
    const ok = await waitFor(() => lastMsg().startsWith("C-x-:"))
    expect(ok).toBe(true)
    expect(lastMsg()).toContain("C-s → save-buffer")
    expect(lastMsg()).toContain("4 → +other-window")
  })

  test("follow-up key before the delay cancels the popup", async () => {
    await editor.run("which-key-mode")
    setCustom("which-key-idle-delay", 0.05)
    await keySeq(editor, "C-x", "o")
    const fired = await waitFor(() => messages.some(m => m.startsWith("C-x-:")), 150)
    expect(fired).toBe(false)
  })

  test("reschedules on a deeper prefix", async () => {
    await editor.run("which-key-mode")
    setCustom("which-key-idle-delay", 0.02)
    await keySeq(editor, "C-x", "4")
    expect(editor.keymaps.pendingSequence()).toBe("C-x 4")
    const ok = await waitFor(() => lastMsg().startsWith("C-x 4-:"))
    expect(ok).toBe(true)
    expect(lastMsg()).toContain("f → find-file-other-window")
  })

  test("does nothing while the mode is disabled", async () => {
    setCustom("which-key-idle-delay", 0.02)
    await keySeq(editor, "C-x")
    const fired = await waitFor(() => messages.some(m => m.startsWith("C-x-:")), 100)
    expect(fired).toBe(false)
  })

  test("respects which-key-separator", () => {
    setCustom("which-key-separator", " : ")
    editor.enableMinorMode("which-key-mode")
    showWhichKey(editor, "C-h")
    expect(lastMsg()).toContain("b : describe-bindings")
  })

  test("cycles pages with which-key page commands", async () => {
    editor.enableMinorMode("which-key-mode")
    editor.lastViewport = { rows: 24, cols: 34 }
    editor.key("C-z a", "alpha-command")
    editor.key("C-z b", "bravo-command")
    editor.key("C-z c", "charlie-command")

    showWhichKey(editor, "C-z")
    expect(lastMsg()).toContain("(1/3)")
    expect(lastMsg()).toContain("a → alpha-command")

    await editor.run("which-key-show-next-page-cycle")
    expect(lastMsg()).toContain("(2/3)")
    expect(lastMsg()).toContain("b → bravo-command")

    await editor.run("which-key-show-next-page-cycle")
    expect(lastMsg()).toContain("(3/3)")
    expect(lastMsg()).toContain("c → charlie-command")

    await editor.run("which-key-show-next-page-cycle")
    expect(lastMsg()).toContain("(1/3)")

    await editor.run("which-key-show-previous-page-cycle")
    expect(lastMsg()).toContain("(3/3)")
  })

  test("which-key-show-top-level displays paged top-level global bindings", async () => {
    editor.lastViewport = { rows: 24, cols: 34 }
    editor.key("C-z", "top-command")
    editor.key("C-y", "yank")
    await editor.run("which-key-show-top-level")
    expect(lastMsg().startsWith("Top-level-:")).toBe(true)
    expect(lastMsg()).toContain("(1/")
    await editor.run("which-key-show-next-page-cycle")
    expect(lastMsg().startsWith("Top-level-:")).toBe(true)
  })
})
