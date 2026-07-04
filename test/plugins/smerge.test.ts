import { describe, expect, test } from "bun:test"
import { makeEditor } from "./helper"
import { keySeq } from "../harness"
import {
  install,
  smergeMatchConflict,
  smergeFindConflicts,
  smergeSpans,
  SMERGE_FACES,
  SMERGE_OVERLAYS_LOCAL,
} from "../../plugins/smerge"

const CONFLICT_2WAY = [
  "before",
  "<<<<<<< HEAD",
  "mine one",
  "mine two",
  "=======",
  "theirs one",
  ">>>>>>> branch",
  "after",
  "",
].join("\n")

const CONFLICT_3WAY = [
  "<<<<<<< HEAD",
  "mine",
  "||||||| base",
  "ancestor",
  "=======",
  "theirs",
  ">>>>>>> branch",
  "",
].join("\n")

const TWO_CONFLICTS = [
  "<<<<<<< HEAD",
  "a-mine",
  "=======",
  "a-theirs",
  ">>>>>>> branch",
  "between",
  "<<<<<<< HEAD",
  "b-mine",
  "=======",
  "b-theirs",
  ">>>>>>> branch",
  "",
].join("\n")

function setup(text: string, point = 0) {
  const editor = makeEditor()
  install(editor)
  const buffer = editor.scratch("*smerge*", text, "text")
  buffer.point = point
  return { editor, buffer }
}

describe("smergeMatchConflict", () => {
  test("parses a 2-way conflict around point", () => {
    const c = smergeMatchConflict(CONFLICT_2WAY, CONFLICT_2WAY.indexOf("mine one"))
    expect(c).not.toBeNull()
    expect(CONFLICT_2WAY.slice(c!.start, c!.upperStart)).toBe("<<<<<<< HEAD\n")
    expect(CONFLICT_2WAY.slice(c!.upperStart, c!.upperEnd)).toBe("mine one\nmine two\n")
    expect(CONFLICT_2WAY.slice(c!.upperEnd, c!.lowerStart)).toBe("=======\n")
    expect(CONFLICT_2WAY.slice(c!.lowerStart, c!.lowerEnd)).toBe("theirs one\n")
    expect(CONFLICT_2WAY.slice(c!.lowerEnd, c!.end)).toBe(">>>>>>> branch\n")
    expect(c!.baseStart).toBeNull()
  })

  test("parses a diff3 -A conflict with a base region", () => {
    const c = smergeMatchConflict(CONFLICT_3WAY, 0)
    expect(c).not.toBeNull()
    expect(CONFLICT_3WAY.slice(c!.upperStart, c!.upperEnd)).toBe("mine\n")
    expect(CONFLICT_3WAY.slice(c!.baseStart!, c!.baseEnd!)).toBe("ancestor\n")
    expect(CONFLICT_3WAY.slice(c!.lowerStart, c!.lowerEnd)).toBe("theirs\n")
  })

  test("matches when point is on the begin marker line", () => {
    const c = smergeMatchConflict(CONFLICT_2WAY, CONFLICT_2WAY.indexOf("<<<<<<<"))
    expect(c).not.toBeNull()
    expect(c!.start).toBe(CONFLICT_2WAY.indexOf("<<<<<<<"))
  })

  test("returns null when point is outside any conflict", () => {
    expect(smergeMatchConflict(CONFLICT_2WAY, 0)).toBeNull()
    expect(smergeMatchConflict(CONFLICT_2WAY, CONFLICT_2WAY.indexOf("after"))).toBeNull()
    expect(smergeMatchConflict("no markers here\n", 5)).toBeNull()
  })

  test("returns null for malformed conflict (missing ======= separator)", () => {
    const text = "<<<<<<< HEAD\nmine\n>>>>>>> branch\n"
    expect(smergeMatchConflict(text, 0)).toBeNull()
  })

  test("returns null when a nested begin marker appears", () => {
    const text = "<<<<<<< outer\n<<<<<<< inner\nx\n=======\ny\n>>>>>>> inner\n"
    expect(smergeMatchConflict(text, 0)).toBeNull()
  })
})

describe("smergeFindConflicts", () => {
  test("finds all conflicts in order", () => {
    const all = smergeFindConflicts(TWO_CONFLICTS)
    expect(all.length).toBe(2)
    expect(all[0]!.start).toBe(0)
    expect(all[1]!.start).toBe(TWO_CONFLICTS.indexOf("<<<<<<< HEAD\nb-mine"))
  })

  test("returns empty for text without markers", () => {
    expect(smergeFindConflicts("plain\ntext\n")).toEqual([])
  })
})

describe("smerge-mode minor mode", () => {
  test("toggle command enables and disables buffer-locally", async () => {
    const { editor, buffer } = setup(CONFLICT_2WAY)
    expect(editor.isMinorModeEnabled("smerge-mode", buffer)).toBe(false)
    await editor.run("smerge-mode")
    expect(editor.isMinorModeEnabled("smerge-mode", buffer)).toBe(true)
    expect(editor.minorModeLighters(buffer)).toContain("SMerge")
    await editor.run("smerge-mode")
    expect(editor.isMinorModeEnabled("smerge-mode", buffer)).toBe(false)
  })

  test("is buffer-local, not global", async () => {
    const { editor, buffer } = setup(CONFLICT_2WAY)
    await editor.run("smerge-mode")
    const other = editor.scratch("*other*", "plain", "text")
    expect(editor.isMinorModeEnabled("smerge-mode", buffer)).toBe(true)
    expect(editor.isMinorModeEnabled("smerge-mode", other)).toBe(false)
  })

  test("find-file-hook auto-enables when conflict markers are present", async () => {
    const { editor } = setup("plain")
    const buffer = editor.scratch("*conflicted*", CONFLICT_2WAY, "text")
    await editor.runHook("find-file-hook", buffer)
    expect(editor.isMinorModeEnabled("smerge-mode", buffer)).toBe(true)
  })

  test("find-file-hook does not enable for clean files", async () => {
    const { editor } = setup("plain")
    const buffer = editor.scratch("*clean*", "no markers here\n", "text")
    await editor.runHook("find-file-hook", buffer)
    expect(editor.isMinorModeEnabled("smerge-mode", buffer)).toBe(false)
  })
})

describe("smerge-next / smerge-prev", () => {
  test("smerge-next jumps to the next conflict's begin marker", async () => {
    const { editor, buffer } = setup(TWO_CONFLICTS, TWO_CONFLICTS.indexOf("between"))
    await editor.run("smerge-mode")
    await editor.run("smerge-next")
    expect(buffer.point).toBe(TWO_CONFLICTS.indexOf("<<<<<<< HEAD\nb-mine"))
  })

  test("smerge-next from inside first conflict goes to the second", async () => {
    const { editor, buffer } = setup(TWO_CONFLICTS, TWO_CONFLICTS.indexOf("a-mine"))
    await editor.run("smerge-mode")
    await editor.run("smerge-next")
    expect(buffer.point).toBe(TWO_CONFLICTS.indexOf("<<<<<<< HEAD\nb-mine"))
  })

  test("smerge-next at last conflict reports no next", async () => {
    const { editor, buffer } = setup(TWO_CONFLICTS, TWO_CONFLICTS.indexOf("b-mine"))
    await editor.run("smerge-mode")
    let msg = ""
    editor.events.on("message", ({ text }) => { msg = text })
    await editor.run("smerge-next")
    expect(msg).toContain("No next conflict")
    expect(buffer.point).toBe(TWO_CONFLICTS.indexOf("b-mine"))
  })

  test("smerge-prev jumps to the previous conflict", async () => {
    const second = TWO_CONFLICTS.indexOf("<<<<<<< HEAD\nb-mine")
    const { editor, buffer } = setup(TWO_CONFLICTS, TWO_CONFLICTS.indexOf("b-mine"))
    await editor.run("smerge-mode")
    // From inside the second conflict, prev first lands on its own begin marker
    // (matches easy-mmode-define-navigation's re-search-backward semantics).
    await editor.run("smerge-prev")
    expect(buffer.point).toBe(second)
    await editor.run("smerge-prev")
    expect(buffer.point).toBe(0)
  })

  test("smerge-prev at first conflict reports no previous", async () => {
    const { editor, buffer } = setup(TWO_CONFLICTS, 0)
    await editor.run("smerge-mode")
    let msg = ""
    editor.events.on("message", ({ text }) => { msg = text })
    await editor.run("smerge-prev")
    expect(msg).toContain("No previous conflict")
    expect(buffer.point).toBe(0)
  })

  test("C-c ^ n / C-c ^ p dispatch through the minor-mode keymap", async () => {
    const { editor, buffer } = setup(TWO_CONFLICTS, TWO_CONFLICTS.indexOf("between"))
    await editor.run("smerge-mode")
    await keySeq(editor, "C-c", "^", "n")
    expect(buffer.point).toBe(TWO_CONFLICTS.indexOf("<<<<<<< HEAD\nb-mine"))
    await keySeq(editor, "C-c", "^", "p")
    expect(buffer.point).toBe(0)
  })
})

describe("smerge-keep-*", () => {
  test("smerge-keep-upper keeps mine and drops markers", async () => {
    const { editor, buffer } = setup(CONFLICT_2WAY, CONFLICT_2WAY.indexOf("======="))
    await editor.run("smerge-mode")
    await editor.run("smerge-keep-upper")
    expect(buffer.text).toBe("before\nmine one\nmine two\nafter\n")
    expect(buffer.point).toBe("before\n".length)
  })

  test("smerge-keep-lower keeps theirs", async () => {
    const { editor, buffer } = setup(CONFLICT_2WAY, CONFLICT_2WAY.indexOf("mine one"))
    await editor.run("smerge-mode")
    await editor.run("smerge-keep-lower")
    expect(buffer.text).toBe("before\ntheirs one\nafter\n")
  })

  test("smerge-keep-all concatenates upper + lower", async () => {
    const { editor, buffer } = setup(CONFLICT_2WAY, CONFLICT_2WAY.indexOf("mine one"))
    await editor.run("smerge-mode")
    await editor.run("smerge-keep-all")
    expect(buffer.text).toBe("before\nmine one\nmine two\ntheirs one\nafter\n")
  })

  test("smerge-keep-all on diff3 conflict concatenates upper + base + lower", async () => {
    const { editor, buffer } = setup(CONFLICT_3WAY, 0)
    await editor.run("smerge-mode")
    await editor.run("smerge-keep-all")
    expect(buffer.text).toBe("mine\nancestor\ntheirs\n")
  })

  test("smerge-keep-base reverts to ancestor on diff3 conflict", async () => {
    const { editor, buffer } = setup(CONFLICT_3WAY, CONFLICT_3WAY.indexOf("theirs"))
    await editor.run("smerge-mode")
    await editor.run("smerge-keep-base")
    expect(buffer.text).toBe("ancestor\n")
  })

  test("smerge-keep-base errors when there is no base", async () => {
    const { editor, buffer } = setup(CONFLICT_2WAY, CONFLICT_2WAY.indexOf("mine one"))
    await editor.run("smerge-mode")
    let msg = ""
    editor.events.on("message", ({ text }) => { msg = text })
    await editor.run("smerge-keep-base")
    expect(msg).toContain("No `base'")
    expect(buffer.text).toBe(CONFLICT_2WAY)
  })

  test("keep-* outside a conflict reports and leaves buffer unchanged", async () => {
    const { editor, buffer } = setup(CONFLICT_2WAY, 0)
    await editor.run("smerge-mode")
    let msg = ""
    editor.events.on("message", ({ text }) => { msg = text })
    await editor.run("smerge-keep-upper")
    expect(msg).toContain("Point not in conflict region")
    expect(buffer.text).toBe(CONFLICT_2WAY)
  })

  test("smerge-keep-mine / smerge-keep-other are aliases", async () => {
    const { editor: e1, buffer: b1 } = setup(CONFLICT_2WAY, CONFLICT_2WAY.indexOf("mine one"))
    await e1.run("smerge-mode")
    await e1.run("smerge-keep-mine")
    expect(b1.text).toBe("before\nmine one\nmine two\nafter\n")

    const { editor: e2, buffer: b2 } = setup(CONFLICT_2WAY, CONFLICT_2WAY.indexOf("mine one"))
    await e2.run("smerge-mode")
    await e2.run("smerge-keep-other")
    expect(b2.text).toBe("before\ntheirs one\nafter\n")
  })

  test("C-c ^ m / C-c ^ o / C-c ^ a dispatch keep commands", async () => {
    const { editor, buffer } = setup(CONFLICT_2WAY, CONFLICT_2WAY.indexOf("mine one"))
    await editor.run("smerge-mode")
    await keySeq(editor, "C-c", "^", "m")
    expect(buffer.text).toBe("before\nmine one\nmine two\nafter\n")

    const { editor: e2, buffer: b2 } = setup(CONFLICT_2WAY, CONFLICT_2WAY.indexOf("mine one"))
    await e2.run("smerge-mode")
    await keySeq(e2, "C-c", "^", "o")
    expect(b2.text).toBe("before\ntheirs one\nafter\n")

    const { editor: e3, buffer: b3 } = setup(CONFLICT_2WAY, CONFLICT_2WAY.indexOf("mine one"))
    await e3.run("smerge-mode")
    await keySeq(e3, "C-c", "^", "a")
    expect(b3.text).toBe("before\nmine one\nmine two\ntheirs one\nafter\n")
  })

  test("auto-leave disables smerge-mode after the last conflict is resolved", async () => {
    const { editor, buffer } = setup(CONFLICT_2WAY, CONFLICT_2WAY.indexOf("mine one"))
    await editor.run("smerge-mode")
    let msg = ""
    editor.events.on("message", ({ text }) => { msg = text })
    await editor.run("smerge-keep-upper")
    expect(editor.isMinorModeEnabled("smerge-mode", buffer)).toBe(false)
    expect(msg).toContain("No conflicts remain")
  })

  test("auto-leave keeps smerge-mode while conflicts remain", async () => {
    const { editor, buffer } = setup(TWO_CONFLICTS, TWO_CONFLICTS.indexOf("a-mine"))
    await editor.run("smerge-mode")
    await editor.run("smerge-keep-upper")
    expect(editor.isMinorModeEnabled("smerge-mode", buffer)).toBe(true)
    expect(buffer.text).toContain("<<<<<<< HEAD\nb-mine")
  })
})

describe("smerge-swap", () => {
  test("swaps upper and lower while keeping conflict markers", async () => {
    const { editor, buffer } = setup(CONFLICT_3WAY, CONFLICT_3WAY.indexOf("mine"))
    await editor.run("smerge-mode")
    await editor.run("smerge-swap")
    expect(buffer.text).toBe([
      "<<<<<<< HEAD",
      "theirs",
      "||||||| base",
      "ancestor",
      "=======",
      "mine",
      ">>>>>>> branch",
      "",
    ].join("\n"))
    expect(buffer.point).toBe(0)
  })
})

describe("smerge-combine-with-next", () => {
  test("combines current and next conflicts into one conflict region", async () => {
    const { editor, buffer } = setup(TWO_CONFLICTS, TWO_CONFLICTS.indexOf("a-mine"))
    await editor.run("smerge-mode")
    await editor.run("smerge-combine-with-next")
    expect(buffer.text).toBe([
      "<<<<<<< HEAD",
      "a-mine",
      "between",
      "b-mine",
      "=======",
      "a-theirs",
      "between",
      "b-theirs",
      ">>>>>>> branch",
      "",
    ].join("\n"))
    expect(smergeFindConflicts(buffer.text).length).toBe(1)
    expect(buffer.point).toBe(0)
  })

  test("C-c ^ C dispatches combine-with-next", async () => {
    const { editor, buffer } = setup(TWO_CONFLICTS, TWO_CONFLICTS.indexOf("a-mine"))
    await editor.run("smerge-mode")
    await keySeq(editor, "C-c", "^", "C")
    expect(smergeFindConflicts(buffer.text).length).toBe(1)
    expect(buffer.text).toContain("a-mine\nbetween\nb-mine")
  })

  test("reports when there is no next conflict", async () => {
    const { editor, buffer } = setup(CONFLICT_2WAY, CONFLICT_2WAY.indexOf("mine one"))
    await editor.run("smerge-mode")
    let msg = ""
    editor.events.on("message", ({ text }) => { msg = text })
    await editor.run("smerge-combine-with-next")
    expect(msg).toContain("No next conflict")
    expect(buffer.text).toBe(CONFLICT_2WAY)
  })
})

describe("smerge-resolve", () => {
  test("takes lower when upper equals base", async () => {
    const text = [
      "<<<<<<< HEAD",
      "same",
      "||||||| base",
      "same",
      "=======",
      "lower",
      ">>>>>>> branch",
      "",
    ].join("\n")
    const { editor, buffer } = setup(text, text.indexOf("same"))
    await editor.run("smerge-mode")
    await editor.run("smerge-resolve")
    expect(buffer.text).toBe("lower\n")
    expect(editor.isMinorModeEnabled("smerge-mode", buffer)).toBe(false)
  })

  test("takes upper when lower equals base", async () => {
    const text = [
      "<<<<<<< HEAD",
      "upper",
      "||||||| base",
      "same",
      "=======",
      "same",
      ">>>>>>> branch",
      "",
    ].join("\n")
    const { editor, buffer } = setup(text, text.indexOf("upper"))
    await editor.run("smerge-mode")
    await editor.run("smerge-resolve")
    expect(buffer.text).toBe("upper\n")
  })

  test("takes either side when upper equals lower", async () => {
    const text = [
      "<<<<<<< HEAD",
      "same",
      "=======",
      "same",
      ">>>>>>> branch",
      "",
    ].join("\n")
    const { editor, buffer } = setup(text, text.indexOf("same"))
    await editor.run("smerge-mode")
    await editor.run("smerge-resolve")
    expect(buffer.text).toBe("same\n")
  })

  test("reports when the conflict is not trivially resolvable", async () => {
    const { editor, buffer } = setup(CONFLICT_3WAY, CONFLICT_3WAY.indexOf("mine"))
    await editor.run("smerge-mode")
    let msg = ""
    editor.events.on("message", ({ text }) => { msg = text })
    await editor.run("smerge-resolve")
    expect(msg).toContain("Don't know how to resolve")
    expect(buffer.text).toBe(CONFLICT_3WAY)
    expect(editor.isMinorModeEnabled("smerge-mode", buffer)).toBe(true)
  })

  test("C-c ^ RET and C-c ^ R dispatch resolve", async () => {
    const enterText = [
      "<<<<<<< HEAD",
      "same",
      "=======",
      "same",
      ">>>>>>> branch",
      "",
    ].join("\n")
    const { editor, buffer } = setup(enterText, enterText.indexOf("same"))
    await editor.run("smerge-mode")
    await keySeq(editor, "C-c", "^", "RET")
    expect(buffer.text).toBe("same\n")

    const rText = [
      "<<<<<<< HEAD",
      "upper",
      "||||||| base",
      "same",
      "=======",
      "same",
      ">>>>>>> branch",
      "",
    ].join("\n")
    const { editor: e2, buffer: b2 } = setup(rText, rText.indexOf("upper"))
    await e2.run("smerge-mode")
    await keySeq(e2, "C-c", "^", "R")
    expect(b2.text).toBe("upper\n")
  })
})

describe("smerge font-lock overlays", () => {
  test("enabling stores spans for markers/upper/lower with distinct faces", async () => {
    const { editor, buffer } = setup(CONFLICT_2WAY)
    await editor.run("smerge-mode")
    const spans = smergeSpans(buffer)
    const faceAt = (pos: number) => spans.find(s => s.start <= pos && pos < s.end)?.face
    expect(faceAt(CONFLICT_2WAY.indexOf("<<<<<<<"))).toBe(SMERGE_FACES.markers)
    expect(faceAt(CONFLICT_2WAY.indexOf("mine one"))).toBe(SMERGE_FACES.upper)
    expect(faceAt(CONFLICT_2WAY.indexOf("======="))).toBe(SMERGE_FACES.markers)
    expect(faceAt(CONFLICT_2WAY.indexOf("theirs one"))).toBe(SMERGE_FACES.lower)
    expect(faceAt(CONFLICT_2WAY.indexOf(">>>>>>>"))).toBe(SMERGE_FACES.markers)
    expect(faceAt(0)).toBeUndefined()
    expect(faceAt(CONFLICT_2WAY.indexOf("after"))).toBeUndefined()
  })

  test("upper, lower, and markers get three distinct faces", async () => {
    const { editor, buffer } = setup(CONFLICT_2WAY)
    await editor.run("smerge-mode")
    const faces = new Set(smergeSpans(buffer).map(s => s.face))
    expect(faces.size).toBe(3)
  })

  test("diff3 conflict adds a fourth face for base", async () => {
    const { editor, buffer } = setup(CONFLICT_3WAY)
    await editor.run("smerge-mode")
    const spans = smergeSpans(buffer)
    const faceAt = (pos: number) => spans.find(s => s.start <= pos && pos < s.end)?.face
    expect(faceAt(CONFLICT_3WAY.indexOf("ancestor"))).toBe(SMERGE_FACES.base)
    expect(new Set(spans.map(s => s.face)).size).toBe(4)
  })

  test("spans refresh after a keep operation", async () => {
    const { editor, buffer } = setup(TWO_CONFLICTS, TWO_CONFLICTS.indexOf("a-mine"))
    await editor.run("smerge-mode")
    expect(smergeSpans(buffer).filter(s => s.face === SMERGE_FACES.upper).length).toBe(2)
    await editor.run("smerge-keep-upper")
    expect(smergeSpans(buffer).filter(s => s.face === SMERGE_FACES.upper).length).toBe(1)
  })

  test("disabling clears overlay spans", async () => {
    const { editor, buffer } = setup(CONFLICT_2WAY)
    await editor.run("smerge-mode")
    expect(smergeSpans(buffer).length).toBeGreaterThan(0)
    await editor.run("smerge-mode")
    expect(buffer.locals.has(SMERGE_OVERLAYS_LOCAL)).toBe(false)
    expect(smergeSpans(buffer)).toEqual([])
  })
})
