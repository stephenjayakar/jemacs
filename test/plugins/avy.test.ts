import { describe, expect, test } from "bun:test"
import { makeEditor } from "./helper"
import { displayRows, parseKey } from "../harness"
import { install, avyLabels, avyCollect, avySpans, AVY_KEYS } from "../../plugins/avy"

const tick = () => new Promise(r => setTimeout(r, 0))

function setup(text: string, point = 0) {
  const editor = makeEditor()
  install(editor)
  const buf = editor.scratch("*avy*", text)
  buf.point = point
  const fire = (t: string) => { void editor.handleKey(parseKey(t)) }
  return { editor, buf, fire }
}

describe("avyLabels", () => {
  test("≤ k targets get single-key labels", () => {
    expect(avyLabels(1)).toEqual(["a"])
    expect(avyLabels(3)).toEqual(["a", "s", "d"])
    expect(avyLabels(9)).toEqual([...AVY_KEYS])
  })

  test("> k targets spill into prefix-free 2-key labels", () => {
    const labels = avyLabels(12)
    expect(labels).toHaveLength(12)
    expect(new Set(labels).size).toBe(12)
    // No 1-key label is a prefix of any 2-key label.
    const ones = labels.filter(l => l.length === 1)
    const twos = labels.filter(l => l.length === 2)
    expect(twos.length).toBeGreaterThan(0)
    for (const one of ones) for (const two of twos) expect(two.startsWith(one)).toBe(false)
    expect(labels.every(l => l.length <= 2)).toBe(true)
  })

  test("uses as few prefixes as possible", () => {
    // 10 targets, k=9: one prefix suffices (8 singles + up to 9 doubles).
    const labels = avyLabels(10)
    expect(labels.filter(l => l.length === 1)).toHaveLength(8)
    expect(labels.filter(l => l.length === 2)).toHaveLength(2)
  })
})

describe("avyCollect", () => {
  test("finds matches inside the visible region only", () => {
    const { editor } = setup("foo bar foo\nbaz foo")
    const hits = avyCollect(editor, "o")
    expect(hits.map(h => h.point)).toEqual([1, 2, 9, 10, 17, 18])
  })

  test("respects window startLine for visible range", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i} x`).join("\n")
    const { editor } = setup(lines)
    // Scroll the only leaf 40 lines down; matches before that are off-screen.
    const leaf = editor.selectedWindowLeaf()!
    editor.setSelectedWindowStartLine(40)
    const hits = avyCollect(editor, "x", 10)
    expect(hits.length).toBe(10)
    // First visible 'x' is on line 40.
    expect(editor.buffers.get(leaf.bufferId)!.text.slice(0, hits[0]!.point).split("\n").length - 1).toBe(40)
  })

  test("collects across all visible windows", () => {
    const { editor } = setup("xx")
    editor.splitWindowRight()
    const hits = avyCollect(editor, "x")
    expect(hits).toHaveLength(4)
    expect(new Set(hits.map(h => h.windowId)).size).toBe(2)
  })
})

describe("avy-goto-char", () => {
  test("C-; is bound", () => {
    const { editor } = setup("")
    expect(editor.keymap.get("C-;")).toBe("avy-goto-char")
  })

  test("single match jumps immediately without labelling", async () => {
    const { editor, buf, fire } = setup("hello world", 0)
    fire("C-;"); await tick()
    fire("w"); await tick()
    expect(buf.point).toBe(6)
    expect(buf.text).toBe("hello world")
    expect(buf.dirty).toBe(false)
  })

  test("labels overlay matches in the rendered body, then jump moves point", async () => {
    const { editor, buf, fire } = setup("foo bar foo", 11)
    fire("C-;"); await tick()
    fire("o"); await tick()
    // Four 'o's → labels a s d f painted over them; cursor sits past EOL.
    const row = displayRows(editor)[0]!
    expect(row).toContain("fas bar fdf")
    expect(avySpans(buf).map(s => s.start)).toEqual([1, 2, 9, 10])
    expect(avySpans(buf).every(s => s.face === "isearch")).toBe(true)
    fire("d"); await tick()
    expect(buf.point).toBe(9)
    expect(buf.text).toBe("foo bar foo")
    expect(buf.dirty).toBe(false)
    expect(avySpans(buf)).toEqual([])
  })

  test("two-key label path: first key narrows, second key selects", async () => {
    // Space targets out so 2-char labels don't overlap.
    const text = Array.from({ length: 12 }, () => "x").join("  ")
    const { editor, buf, fire } = setup(text, text.length)
    fire("C-;"); await tick()
    fire("x"); await tick()
    const labels = avyLabels(12)
    const two = labels.find(l => l.length === 2)!
    const idx = labels.indexOf(two)
    expect(displayRows(editor)[0]).toContain(two)
    fire(two[0]!); await tick()
    expect(buf.text).not.toBe(text) // still painted while waiting for the 2nd key
    fire(two[1]!); await tick()
    expect(buf.point).toBe(idx * 3)
    expect(buf.text).toBe(text)
  })

  test("C-g during label read restores buffer text and point", async () => {
    const { buf, fire } = setup("oo oo", 3)
    fire("C-;"); await tick()
    fire("o"); await tick()
    expect(buf.text).not.toBe("oo oo")
    fire("C-g"); await tick()
    expect(buf.text).toBe("oo oo")
    expect(buf.point).toBe(3)
    expect(buf.dirty).toBe(false)
  })

  test("no matches messages and leaves point alone", async () => {
    const { editor, buf, fire } = setup("hello", 2)
    let msg = ""
    editor.events.on("message", ({ text }) => { msg = text })
    fire("C-;"); await tick()
    fire("z"); await tick()
    expect(msg).toContain("No candidates")
    expect(buf.point).toBe(2)
  })

  test("unknown label key aborts and restores", async () => {
    const { editor, buf, fire } = setup("oo", 0)
    let msg = ""
    editor.events.on("message", ({ text }) => { msg = text })
    fire("C-;"); await tick()
    fire("o"); await tick()
    fire("z"); await tick()
    expect(msg).toContain("No such candidate")
    expect(buf.text).toBe("oo")
  })

  test("jumping to a match in another window selects that window", async () => {
    const { editor, fire } = setup("zap")
    editor.splitWindowRight() // selects the new (second) leaf
    const [first, second] = avyCollect(editor, "z").map(h => h.windowId)
    expect(editor.selectedWindowId).toBe(second)
    fire("C-;"); await tick()
    fire("z"); await tick()
    // Two windows showing the same buffer → two 'z' targets, labels a & s.
    fire("a"); await tick()
    expect(editor.selectedWindowId).toBe(first)
    expect(editor.currentBuffer.point).toBe(0)
  })

  test("2-char label at end-of-line paints only the first glyph", async () => {
    // 12 single-char lines → 12 targets → some 2-key labels land at EOL.
    const text = Array.from({ length: 12 }, () => "x").join("\n")
    const { editor, fire } = setup(text, 0)
    fire("C-;"); await tick()
    fire("x"); await tick()
    for (const row of displayRows(editor).slice(0, 12)) expect(row).toHaveLength(1)
    fire("C-g"); await tick()
  })
})
