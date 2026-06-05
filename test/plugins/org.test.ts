import { describe, expect, test } from "bun:test"
import { makeEditor } from "./helper"
import { keySeq } from "../harness"
import {
  install,
  orgParseHeadlines,
  orgHeadlineAtPoint,
  orgSubtreeEndLine,
  orgChildren,
  orgFontLock,
  orgVisibleSpans,
  orgDisplayFilter,
  ORG_FOLDED_LOCAL,
  type FoldRange,
} from "../../plugins/org"
import { getMode } from "../../src/modes/mode"

const DOC = [
  "* Top",            // 0
  "body a",           // 1
  "** TODO Child A",  // 2
  "a1",               // 3
  "*** Grand",        // 4
  "g1",               // 5
  "** DONE Child B",  // 6
  "b1",               // 7
  "* Second",         // 8
  "",                 // 9 (trailing newline → empty line)
].join("\n")

function setup(text: string, point = 0) {
  const editor = makeEditor()
  install(editor)
  const buffer = editor.scratch("test.org", text, "org-mode")
  buffer.point = point
  return { editor, buffer }
}

function folded(buffer: ReturnType<typeof setup>["buffer"]): FoldRange[] {
  return (buffer.locals.get(ORG_FOLDED_LOCAL) as FoldRange[] | undefined) ?? []
}

describe("orgParseHeadlines", () => {
  test("parses level, keyword, title and offsets", () => {
    const hs = orgParseHeadlines(DOC)
    expect(hs.map(h => [h.line, h.level, h.keyword, h.title])).toEqual([
      [0, 1, null, "Top"],
      [2, 2, "TODO", "Child A"],
      [4, 3, null, "Grand"],
      [6, 2, "DONE", "Child B"],
      [8, 1, null, "Second"],
    ])
    expect(DOC.slice(hs[1]!.start, hs[1]!.end)).toBe("** TODO Child A")
  })

  test("ignores body lines and indented stars", () => {
    const hs = orgParseHeadlines("plain\n * not a heading\n*real\n* yes\n")
    // "*real" has no space after the stars; " * not" has leading space.
    expect(hs.map(h => h.title)).toEqual(["yes"])
  })

  test("orgHeadlineAtPoint resolves point inside the headline line, null elsewhere", () => {
    expect(orgHeadlineAtPoint(DOC, DOC.indexOf("Child A"))?.title).toBe("Child A")
    expect(orgHeadlineAtPoint(DOC, DOC.indexOf("body a"))).toBeNull()
  })

  test("subtree extent and direct children", () => {
    const hs = orgParseHeadlines(DOC)
    const lc = DOC.split("\n").length
    const top = hs[0]!
    expect(orgSubtreeEndLine(hs, top, lc)).toBe(7)
    expect(orgChildren(hs, top, lc).map(c => c.title)).toEqual(["Child A", "Child B"])
    expect(orgSubtreeEndLine(hs, hs[1]!, lc)).toBe(5) // Child A subtree ends before Child B
  })
})

describe("org-cycle (TAB)", () => {
  test("subtree → folded hides everything under the heading", async () => {
    const { editor, buffer } = setup(DOC, 0)
    await editor.run("org-cycle")
    expect(folded(buffer)).toEqual([[1, 7]])
  })

  test("folded → children shows direct children, folds grandchildren", async () => {
    const { editor, buffer } = setup(DOC, 0)
    await editor.run("org-cycle") // → folded
    await editor.run("org-cycle") // → children
    // body line 1 visible; Child A subtree body (3..5) and Child B body (7) folded
    expect(folded(buffer)).toEqual([[3, 5], [7, 7]])
  })

  test("children → subtree clears all folds under the heading", async () => {
    const { editor, buffer } = setup(DOC, 0)
    await editor.run("org-cycle")
    await editor.run("org-cycle")
    await editor.run("org-cycle") // → subtree
    expect(folded(buffer)).toEqual([])
  })

  test("cycling one heading does not disturb a sibling's fold state", async () => {
    const { editor, buffer } = setup(DOC, DOC.indexOf("* Second"))
    buffer.locals.set(ORG_FOLDED_LOCAL, [[1, 7]] as FoldRange[])
    await editor.run("org-cycle") // Second has only trailing blank line
    // Top's fold preserved
    expect(folded(buffer).some(([a]) => a === 1)).toBe(true)
  })

  test("TAB on a body line reports and changes nothing", async () => {
    const { editor, buffer } = setup(DOC, DOC.indexOf("body a"))
    let msg = ""
    editor.events.on("message", ({ text }) => { msg = text })
    await editor.run("org-cycle")
    expect(msg).toContain("Not at a heading")
    expect(folded(buffer)).toEqual([])
  })

  test("orgVisibleSpans maps folded line ranges to character offsets", async () => {
    const { editor, buffer } = setup(DOC, 0)
    await editor.run("org-cycle") // fold lines 1..7
    const spans = orgVisibleSpans(buffer)
    expect(spans.length).toBe(1)
    const [{ start, end }] = spans
    // hidden text begins at the newline after "* Top" and ends at end of "b1"
    expect(DOC.slice(start, end)).toBe("\nbody a\n** TODO Child A\na1\n*** Grand\ng1\n** DONE Child B\nb1")
  })

  test("orgDisplayFilter collapses folded lines and remaps offsets", async () => {
    const { editor, buffer } = setup(DOC, 0)
    expect(orgDisplayFilter(buffer)).toBeNull() // identity when nothing folded
    await editor.run("org-cycle") // fold 1..7
    const filt = orgDisplayFilter(buffer)!
    expect(filt.text).toBe("* Top...\n* Second\n")
    expect(filt.map(DOC.indexOf("Top"))).toBe(filt.text.indexOf("Top"))
    expect(filt.map(DOC.indexOf("* Second"))).toBe(filt.text.indexOf("* Second"))
    // Hidden offsets clamp to the headline's end (where the ellipsis sits).
    expect(filt.map(DOC.indexOf("Child A"))).toBe("* Top".length)
    expect(filt.map(DOC.indexOf("b1"))).toBe("* Top".length)
  })

  test("displayFilter is registered on org-mode", () => {
    setup(DOC)
    expect(getMode("org-mode")?.displayFilter).toBe(orgDisplayFilter)
  })

  test("TAB key dispatches org-cycle through the major-mode keymap", async () => {
    const { editor, buffer } = setup(DOC, 0)
    await keySeq(editor, "TAB")
    expect(folded(buffer)).toEqual([[1, 7]])
  })
})

describe("org-todo (C-c C-t)", () => {
  test("none → TODO → DONE → none", async () => {
    const { editor, buffer } = setup("* Heading\n", 0)
    await editor.run("org-todo")
    expect(buffer.text).toBe("* TODO Heading\n")
    await editor.run("org-todo")
    expect(buffer.text).toBe("* DONE Heading\n")
    await editor.run("org-todo")
    expect(buffer.text).toBe("* Heading\n")
  })

  test("preserves stars at deeper levels", async () => {
    const { editor, buffer } = setup("*** TODO deep\n", 2)
    await editor.run("org-todo")
    expect(buffer.text).toBe("*** DONE deep\n")
  })

  test("C-c C-t dispatches via the mode keymap", async () => {
    const { editor, buffer } = setup("* x\n", 0)
    await keySeq(editor, "C-c", "C-t")
    expect(buffer.text).toBe("* TODO x\n")
  })

  test("no-op on a body line", async () => {
    const { editor, buffer } = setup("* h\nbody\n", 4)
    await editor.run("org-todo")
    expect(buffer.text).toBe("* h\nbody\n")
  })
})

describe("org-meta-return (M-RET)", () => {
  test("inserts a sibling after the current subtree", async () => {
    const { editor, buffer } = setup(DOC, DOC.indexOf("** TODO Child A"))
    await editor.run("org-meta-return")
    // New "** " sibling goes after Child A's subtree (after line 5), before Child B.
    expect(buffer.text).toContain("g1\n** \n** DONE Child B")
    expect(buffer.text[buffer.point - 1]).toBe(" ")
    expect(buffer.text.slice(buffer.point - 3, buffer.point)).toBe("** ")
  })

  test("from body text uses the enclosing heading's level", async () => {
    const { editor, buffer } = setup("* A\nbody\n", 5)
    await editor.run("org-meta-return")
    expect(buffer.text).toBe("* A\nbody\n* \n")
  })

  test("in an empty buffer inserts a level-1 heading", async () => {
    const { editor, buffer } = setup("", 0)
    await editor.run("org-meta-return")
    expect(buffer.text).toBe("* \n")
    expect(buffer.point).toBe(2)
  })
})

describe("promote / demote (M-left / M-right)", () => {
  test("demote adds a star", async () => {
    const { editor, buffer } = setup("* A\n", 0)
    await editor.run("org-demote")
    expect(buffer.text).toBe("** A\n")
  })

  test("promote removes a star and floors at level 1", async () => {
    const { editor, buffer } = setup("** A\n", 0)
    await editor.run("org-promote")
    expect(buffer.text).toBe("* A\n")
    await editor.run("org-promote")
    expect(buffer.text).toBe("* A\n")
  })

  test("M-left / M-right dispatch via the mode keymap", async () => {
    const { editor, buffer } = setup("** A\n", 0)
    await keySeq(editor, "M-right")
    expect(buffer.text).toBe("*** A\n")
    buffer.point = 0
    await keySeq(editor, "M-left")
    expect(buffer.text).toBe("** A\n")
  })
})

describe("heading navigation (C-c C-n / C-c C-p)", () => {
  test("next/previous heading move point", async () => {
    const { editor, buffer } = setup(DOC, 0)
    await editor.run("org-next-heading")
    expect(buffer.point).toBe(DOC.indexOf("** TODO Child A"))
    await editor.run("org-next-heading")
    expect(buffer.point).toBe(DOC.indexOf("*** Grand"))
    await editor.run("org-previous-heading")
    expect(buffer.point).toBe(DOC.indexOf("** TODO Child A"))
  })

  test("at last heading, next reports and stays put", async () => {
    const { editor, buffer } = setup(DOC, DOC.indexOf("* Second"))
    let msg = ""
    editor.events.on("message", ({ text }) => { msg = text })
    await editor.run("org-next-heading")
    expect(msg).toContain("No next heading")
    expect(buffer.point).toBe(DOC.indexOf("* Second"))
  })

  test("C-c C-n dispatches via the mode keymap", async () => {
    const { editor, buffer } = setup(DOC, 0)
    await keySeq(editor, "C-c", "C-n")
    expect(buffer.point).toBe(DOC.indexOf("** TODO Child A"))
  })
})

describe("font-lock", () => {
  test("stars=comment, TODO=keyword, DONE=string, title=function", () => {
    const { buffer } = setup(DOC)
    const spans = orgFontLock(buffer)
    const faceAt = (pos: number) => spans.find(s => s.start <= pos && pos < s.end)?.face
    expect(faceAt(DOC.indexOf("* Top"))).toBe("comment")
    expect(faceAt(DOC.indexOf("Top"))).toBe("function")
    expect(faceAt(DOC.indexOf("TODO"))).toBe("keyword")
    expect(faceAt(DOC.indexOf("DONE"))).toBe("string")
    expect(faceAt(DOC.indexOf("Child A"))).toBe("function")
    expect(faceAt(DOC.indexOf("body a"))).toBeUndefined()
  })

  test("mode registers fontLock so the display layer reaches it", () => {
    setup(DOC)
    expect(getMode("org-mode")?.fontLock).toBe(orgFontLock)
  })
})

describe("auto-mode", () => {
  test("find-file-hook switches .org buffers into org-mode", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("notes", "* h\n", "text")
    buffer.path = "/tmp/notes.org"
    await editor.runHook("find-file-hook", buffer)
    expect(buffer.mode).toBe("org-mode")
  })
})
