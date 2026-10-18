import { describe, expect, test } from "bun:test"
import { makeEditor } from "./helper"
import { displayRows, keySeq } from "../harness"
import { getCustom } from "../../src/runtime/custom"
import { createPluginContext } from "../../src/runtime/plugin-context"
import { rightMarginClick, wrapWords } from "../../src/display/right-margin"
import { bindJemacsHost } from "../../src/run"
import type { UiHost } from "../../src/display/protocol"
import { themedTextPlain } from "../../src/display/themed-text"
import { buildDisplayModel } from "../../src/display/build-display-model"
import { FontMetricsTable } from "../../src/display/font-metrics"
import type { WindowPaneModel } from "../../src/display/protocol"
import { install as installMarkdown } from "../../plugins/markdown"
import {
  install,
  critiqueComments,
  formatCritiqueComment,
  parseCritiqueComments,
  CRITIQUE_MODE,
} from "../../plugins/critique"

function setup(text: string, options: { mode?: boolean } = {}) {
  const editor = makeEditor()
  installMarkdown(editor)
  const ctx = createPluginContext(editor)
  install(editor, ctx)
  const buffer = editor.scratch("doc.md", text, "markdown")
  if (options.mode !== false) editor.enableMinorMode(CRITIQUE_MODE, { buffer })
  buffer.point = 0
  return { editor, buffer, ctx }
}

describe("parseCritiqueComments", () => {
  test("obsidian highlight + comment", () => {
    const text = "a ==fox==%%too quick%% b"
    const [c] = parseCritiqueComments(text)
    expect(c).toMatchObject({ quote: "fox", text: "too quick", syntax: "obsidian", line: 0 })
    expect(text.slice(c!.start, c!.end)).toBe("==fox==%%too quick%%")
    expect(text.slice(c!.highlightStart!, c!.highlightEnd!)).toBe("fox")
    expect(text.slice(c!.commentStart, c!.commentEnd)).toBe("too quick")
  })

  test("obsidian point comment, critic markup, and line numbers", () => {
    const text = "x %%note%%\n{==hi==}{>>c1<<}\n{>>c2<<}"
    const comments = parseCritiqueComments(text)
    expect(comments.map(c => [c.syntax, c.quote, c.text, c.line])).toEqual([
      ["obsidian", "", "note", 0],
      ["critic", "hi", "c1", 1],
      ["critic", "", "c2", 2],
    ])
    expect(text.slice(comments[1]!.highlightStart!, comments[1]!.highlightEnd!)).toBe("hi")
  })

  test("two comments on one line stay separate", () => {
    expect(parseCritiqueComments("==a==%%one%% ==b==%%two%% %%three%%").map(c => [c.quote, c.text]))
      .toEqual([["a", "one"], ["b", "two"], ["", "three"]])
  })

  test("skips code fences, inline code, and bare highlights", () => {
    const text = "```\n==a==%%no%%\n```\n`%%no%%` ==plain highlight== %%yes%%"
    expect(parseCritiqueComments(text).map(c => c.text)).toEqual(["yes"])
  })

  test("allows inline code inside the comment or highlight", () => {
    const text = "==`x`==%%use `y`%% {>>see `z`<<} `a %%b` c%%"
    expect(parseCritiqueComments(text).map(c => c.text)).toEqual(["use `y`", "see `z`"])
  })

  test("a bare highlight doesn't merge into a later commented one", () => {
    expect(parseCritiqueComments("==bare== and ==b=c==%%note%%").map(c => [c.quote, c.text]))
      .toEqual([["b=c", "note"]])
  })

  test("does not span lines (Obsidian block comments are not critique notes)", () => {
    expect(parseCritiqueComments("%%\nblock\n%%")).toEqual([])
  })

  test("format round-trips and sanitizes delimiters", () => {
    expect(formatCritiqueComment("fox", "50%% sure\nreally", "obsidian")).toBe("==fox==%%50% sure really%%")
    expect(formatCritiqueComment(null, "hm", "critic")).toBe("{>>hm<<}")
    const [c] = parseCritiqueComments(formatCritiqueComment("q", "c", "critic"))
    expect(c).toMatchObject({ quote: "q", text: "c" })
  })
})

describe("critique-comment", () => {
  test("C-c ; wraps the region in obsidian markup and turns the mode on", async () => {
    const { editor, buffer } = setup("The quick fox.\n", { mode: false })
    buffer.point = 4
    buffer.setMark()
    buffer.point = 9
    const prompts: string[] = []
    editor.prompt = async p => { prompts.push(p); return "too fast?" }

    await keySeq(editor, "C-c", ";")

    expect(prompts).toEqual(["Comment: "])
    expect(buffer.text).toBe("The ==quick==%%too fast?%% fox.\n")
    expect(buffer.point).toBe("The ==quick==%%too fast?%%".length)
    expect(buffer.mark).toBeNull()
    expect(editor.isMinorModeEnabled(CRITIQUE_MODE, buffer)).toBe(true)
  })

  test("without a region, edits the comment at point", async () => {
    const { editor, buffer } = setup("a ==b==%%old%% c")
    buffer.point = 4
    const seen: Array<[string, string]> = []
    editor.prompt = async (p, initial = "") => { seen.push([p, initial]); return "new" }
    await editor.run("critique-comment")
    expect(seen).toEqual([["Edit comment: ", "old"]])
    expect(buffer.text).toBe("a ==b==%%new%% c")
  })

  test("without a region or comment, inserts a point comment", async () => {
    const { editor, buffer } = setup("ab")
    buffer.point = 1
    editor.prompt = async () => "here"
    await editor.run("critique-comment")
    expect(buffer.text).toBe("a%%here%%b")
  })

  test("critique-syntax critic writes CriticMarkup", async () => {
    const { editor, buffer } = setup("word")
    const { setCustom } = await import("../../src/runtime/custom")
    setCustom("critique-syntax", "critic")
    try {
      buffer.setMark()
      buffer.point = 4
      editor.prompt = async () => "hm"
      await editor.run("critique-comment")
      expect(buffer.text).toBe("{==word==}{>>hm<<}")
    } finally {
      setCustom("critique-syntax", "obsidian")
    }
  })

  test("refuses multi-line regions and empty comments", async () => {
    const { editor, buffer } = setup("one\ntwo")
    buffer.setMark()
    buffer.point = 7
    editor.prompt = async () => "x"
    await editor.run("critique-comment")
    expect(buffer.text).toBe("one\ntwo")

    buffer.clearMark()
    buffer.point = 0
    editor.prompt = async () => "   "
    await editor.run("critique-comment")
    expect(buffer.text).toBe("one\ntwo")
  })

  test("a blank comment on a region or quoted comment leaves a bare highlight", async () => {
    const { editor, buffer } = setup("a quick fox ==b==%%old%%")
    buffer.point = 2
    buffer.setMark()
    buffer.point = 7
    editor.prompt = async () => "  "
    await editor.run("critique-comment")
    expect(buffer.text).toBe("a ==quick== fox ==b==%%old%%")
    expect(buffer.point).toBe("a ==quick==".length)

    buffer.point = buffer.text.length - 3
    editor.prompt = async () => ""
    await editor.run("critique-comment")
    expect(buffer.text).toBe("a ==quick== fox ==b==")
  })
})

describe("navigation and resolve", () => {
  const TEXT = "a ==b==%%one%% c\nd %%two%% e\nf ==g==%%three%%"

  test("next/previous move to each comment's highlight", async () => {
    const { editor, buffer } = setup(TEXT)
    const anchors = critiqueComments(buffer).map(c => c.highlightStart ?? c.start)
    await keySeq(editor, "C-c", "]")
    expect(buffer.point).toBe(anchors[0]!)
    await keySeq(editor, "C-c", "]")
    expect(buffer.point).toBe(anchors[1]!)
    await keySeq(editor, "C-c", "]")
    expect(buffer.point).toBe(anchors[2]!)
    await keySeq(editor, "C-c", "[")
    expect(buffer.point).toBe(anchors[1]!)
  })

  test("C-c / resolves the comment, keeping highlighted text", async () => {
    const { editor, buffer } = setup(TEXT)
    buffer.point = 4
    await keySeq(editor, "C-c", "/")
    expect(buffer.text).toBe("a b c\nd %%two%% e\nf ==g==%%three%%")
  })
})

describe("display", () => {
  const VIEW = { rows: 20, cols: 100 }

  test("comments render in the right margin beside their line, markup hidden", () => {
    const { editor } = setup("# T\n\nThe ==fox==%%too quick%% runs.\n\nPlain %%point note%%line.\n")
    const rows = displayRows(editor, VIEW)
    const foxRow = rows.find(r => r.includes("The fox runs."))!
    expect(foxRow).toBeDefined()
    expect(foxRow).not.toContain("%%")
    expect(foxRow).not.toContain("==")
    expect(foxRow.trimEnd()).toMatch(/│ • too quick +√ \+$/)
    expect(foxRow.indexOf("│")).toBe(VIEW.cols - 36 + 1)
    expect(rows.find(r => r.includes("Plain line."))?.trimEnd()).toMatch(/│ • point note +√ \+$/)
  })

  test("long notes wrap and collisions stack downward", () => {
    const long = "this note is long enough that it has to wrap across several margin rows"
    const { editor } = setup(`a ==x==%%${long}%% ==y==%%second%%\nb\nc\nd\ne\n`)
    const rows = displayRows(editor, VIEW)
    // Every margin cell spans the full margin so DOM hosts keep the bar aligned.
    for (const row of rows.filter(r => r.includes("│"))) expect(row.length).toBe(VIEW.cols)
    // The first line of each note also carries the √ / + buttons (4 cells).
    const margin = rows.map(r => (r.split("│")[1] ?? "").replace(/√ \+\s*$/, "").trim())
    const expected = wrapWords(long, 31, 27)
    expect(margin.slice(0, expected.length + 1)).toEqual([
      `• ${expected[0]}`,
      ...expected.slice(1),
      "• second",
    ])
  })

  const marginHits = (editor: ReturnType<typeof makeEditor>) => {
    const model = buildDisplayModel(editor, { lastMessage: "", viewport: VIEW })
    return model.windows.kind === "leaf" ? model.windows.pane.marginHits ?? [] : []
  }

  test("notes past right-margin-note-max-lines fold behind a clickable …", () => {
    const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ")
    const { editor, buffer } = setup(`a ==x==%%${long}%% ==y==%%second%%\nb\nc\nd\ne\nf\ng\nh\n`)
    const margin = () => displayRows(editor, VIEW).map(r => (r.split("│")[1] ?? "").trim()).filter(Boolean)
    const folded = margin()
    expect(folded).toHaveLength(4)
    expect(folded[2]).toMatch(/ …$/)
    expect(folded[3]).toMatch(/^• second/)
    for (const row of displayRows(editor, VIEW).filter(r => r.includes("│"))) expect(row.length).toBe(VIEW.cols)

    const hit = marginHits(editor).find(h => h.action === "expand")!
    expect(hit).toBeDefined()
    expect(rightMarginClick(buffer, hit.note, "expand")).toBe(true)
    const open = margin()
    expect(open.join(" ")).toContain("word29")
    expect(open[open.length - 2]).toMatch(/ ▴$/)
    expect(open[open.length - 1]).toMatch(/^• second/)

    expect(rightMarginClick(buffer, hit.note, "collapse")).toBe(true)
    expect(margin()).toEqual(folded)
  })

  test("the comment at point shows in full", () => {
    const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ")
    const { editor, buffer } = setup(`a ==x==%%${long}%%\nb\nc\nd\ne\nf\ng\nh\n`)
    buffer.point = buffer.text.indexOf("x")
    const margin = displayRows(editor, VIEW).map(r => (r.split("│")[1] ?? "").trim()).filter(Boolean)
    expect(margin.join(" ")).toContain("word29")
    expect(margin.join(" ")).not.toMatch(/[…▴]/)
  })

  test("notes on the last line get rows past the end of the buffer", () => {
    const { editor } = setup("a ==x==%%first note%% ==y==%%second note%%")
    const margin = displayRows(editor, VIEW).map(r => (r.split("│")[1] ?? "").trim()).filter(Boolean)
    expect(margin.map(m => m.replace(/\s*√ \+$/, ""))).toEqual(["• first note", "• second note"])
  })

  test("margin and highlighting vanish when the mode is off", () => {
    const { editor, buffer } = setup("The ==fox==%%c%% runs.\n")
    editor.disableMinorMode(CRITIQUE_MODE, { buffer })
    const rows = displayRows(editor, VIEW)
    expect(rows.join("\n")).not.toContain("│")
    // markdown-mode hides the `==` highlight markers itself; the comment shows.
    expect(rows[0]).toContain("fox%%c%%")
  })

  test("critique-toggle-inline-comments shows raw markup but keeps the margin", async () => {
    const { editor } = setup("The ==fox==%%c%% runs.\n")
    await keySeq(editor, "C-c", "C-x", ";")
    const row = displayRows(editor, VIEW)[0]!
    expect(row).toContain("fox%%c%%")
    expect(row.trimEnd()).toMatch(/│ • c +√ \+$/)
  })

  test("narrow windows drop the margin instead of crushing the text", () => {
    const { editor } = setup("The ==fox==%%c%% runs.\n")
    expect(displayRows(editor, { rows: 20, cols: 50 }).join("\n")).not.toContain("│")
  })
})

describe("GUI text column (pixel wrap)", () => {
  class EmMetrics extends FontMetricsTable {
    override advance(ch: string, spec: Parameters<FontMetricsTable["advance"]>[1]): number {
      return ch === "\u200b" ? 0 : spec.px * 0.6
    }
    override averageWidth(spec: Parameters<FontMetricsTable["averageWidth"]>[0]): number {
      return spec.px * 0.6
    }
  }
  const gui = { unit: "pixels" as const, mouse: true, clipboard: true, osc52: false, perFaceFonts: true, fontMetrics: new EmMetrics() }
  const VIEW = { rows: 30, cols: 160 }
  const pane = (editor: ReturnType<typeof setup>["editor"]): WindowPaneModel => {
    const model = buildDisplayModel(editor, { lastMessage: "", viewport: VIEW, hostCapabilities: gui })
    return (model.windows.kind === "leaf" ? model.windows.pane : null)!
  }

  test("the margin narrows the column and notes ride as margin chunks", () => {
    const { editor, buffer } = setup("# T\n\nThe ==fox==%%too quick%% runs.\n")
    const withMargin = pane(editor)
    editor.disableMinorMode(CRITIQUE_MODE, { buffer })
    const without = pane(editor)
    expect(withMargin.textColumn).toBeDefined()
    expect(withMargin.textColumn!.leftPx + withMargin.textColumn!.widthPx)
      .toBeLessThan(without.textColumn!.leftPx + without.textColumn!.widthPx)
    const notes = withMargin.body.chunks.filter(c => c.margin).map(c => [c.text.trim(), c.marginAction])
    expect(notes).toEqual([["│ • too quick", "edit"], ["√", "resolve"], ["+", "reply"]])
    expect(without.body.chunks.some(c => c.margin)).toBe(false)
  })

  test("comment text renders as markdown in the margin", () => {
    const { editor, buffer } = setup("See ==this==%%in _The Coddling_ **really** `code`%% ok.\n")
    // Span faces merge over the note face: on the (upright) active note, emphasis shows.
    buffer.point = 5
    const row = displayRows(editor, VIEW).find(r => r.includes("│ •"))!
    expect(row.trimEnd()).toMatch(/│ • in The Coddling really code +√ \+$/)
    const chunk = (text: string) =>
      pane(editor).body.chunks.find(c => c.margin && c.marginAction === "edit" && c.text === text)!
    expect(chunk("The Coddling").italic).toBe(true)
    expect(chunk("code").fg).toBeDefined()
    expect(chunk("code").fg).not.toBe(chunk("The Coddling").fg)
    // The inactive face is italic but not bold, so there strong shows.
    buffer.point = 0
    expect(chunk("really").bold).toBe(true)
  })

  test("window-body-cols excludes the margin, like Emacs window-body-width", () => {
    const { editor, buffer } = setup("The ==fox==%%c%% runs.\n")
    pane(editor)
    expect(buffer.locals.get("window-body-cols")).toBe(VIEW.cols - 36)
    editor.disableMinorMode(CRITIQUE_MODE, { buffer })
    pane(editor)
    expect(buffer.locals.get("window-body-cols")).toBe(VIEW.cols)
  })
})

describe("clicking margin notes", () => {
  const VIEW = { rows: 20, cols: 100 }
  class StubHost implements UiHost {
    readonly label = "stub"
    readonly capabilities = { unit: "cells" as const, mouse: true, clipboard: false, osc52: false }
    async start(): Promise<void> {}
    destroy(): void {}
    present(): void {}
    getViewport() { return VIEW }
    onInput(): void {}
    onResize(): void {}
  }
  const bound = (text: string) => {
    const s = setup(text)
    const binding = bindJemacsHost(s.editor, new StubHost())
    return { ...s, ...binding }
  }
  /** Click the first margin cell for `action`, through the char-grid mouse path. */
  const click = async (b: ReturnType<typeof bound>, action: string) => {
    const model = b.modelFor()
    const pane = model.windows.kind === "leaf" ? model.windows.pane : null
    const hit = pane!.marginHits!.find(h => h.action === action)!
    await b.onInput({ type: "mouse", windowId: b.editor.selectedWindowId, row: hit.row, col: hit.start })
    await Bun.sleep(0)
  }

  test("hits sit on the note's row: text = edit, √ = resolve, + = reply", () => {
    const b = bound("The ==fox==%%too quick%% runs.\n")
    const model = b.modelFor()
    const pane = model.windows.kind === "leaf" ? model.windows.pane : null
    const rows = themedTextPlain(pane!.body).split("\n")
    for (const hit of pane!.marginHits!) {
      const cell = rows[hit.row]!.slice(hit.start, hit.end)
      if (hit.action === "edit") expect(cell).toContain("too quick")
      else expect(cell.trim()).toBe(hit.action === "resolve" ? "√" : "+")
    }
  })

  test("√ resolves the comment", async () => {
    const b = bound("The ==fox==%%too quick%% runs.\n")
    await click(b, "resolve")
    expect(b.buffer.text).toBe("The fox runs.\n")
  })

  test("clicking the text edits it in the minibuffer", async () => {
    const b = bound("The ==fox==%%too quick%% runs.\n")
    const seen: Array<[string, string]> = []
    b.editor.prompt = async (p, initial = "") => { seen.push([p, initial]); return "just right" }
    await click(b, "edit")
    expect(seen).toEqual([["Edit comment: ", "too quick"]])
    expect(b.buffer.text).toBe("The ==fox==%%just right%% runs.\n")
  })

  test("+ adds another comment, which stacks under the first", async () => {
    const b = bound("The ==fox==%%too quick%% runs.\n")
    b.editor.prompt = async () => "agreed"
    await click(b, "reply")
    expect(b.buffer.text).toBe("The ==fox==%%too quick%%%%agreed%% runs.\n")
    const margin = displayRows(b.editor, VIEW).map(r => (r.split("│")[1] ?? "").replace(/√ \+\s*$/, "").trim())
    expect(margin.slice(0, 2)).toEqual(["• too quick", "• agreed"])
  })

  test("DOM hosts send the same click as a pane action", async () => {
    const b = bound("The ==fox==%%too quick%% runs.\n")
    const note = String(critiqueComments(b.buffer)[0]!.start)
    await b.onInput({ type: "pane-action", windowId: b.editor.selectedWindowId, action: "right-margin-click", payload: { note, action: "resolve" } })
    expect(b.buffer.text).toBe("The fox runs.\n")
  })

  test("C-c = replies from the keyboard", async () => {
    const { editor, buffer } = setup("a ==b==%%one%% c")
    buffer.point = 4
    editor.prompt = async () => "two"
    await keySeq(editor, "C-c", "=")
    expect(buffer.text).toBe("a ==b==%%one%%%%two%% c")
  })
})

test("auto-enables on find-file when the file has comments", async () => {
  const { editor } = setup("", { mode: false })
  const { BufferModel } = await import("../../src/kernel/buffer")
  const withComments = editor.addBuffer(new BufferModel({ name: "a.md", text: "x %%n%%", mode: "markdown" }))
  const without = editor.addBuffer(new BufferModel({ name: "b.md", text: "x", mode: "markdown" }))
  await editor.runHook("find-file-hook", withComments)
  await editor.runHook("find-file-hook", without)
  expect(editor.isMinorModeEnabled(CRITIQUE_MODE, withComments)).toBe(true)
  expect(editor.isMinorModeEnabled(CRITIQUE_MODE, without)).toBe(false)
})

test("dispose unregisters the margin, hide, and overlay sources", () => {
  const { editor, ctx } = setup("The ==fox==%%c%% runs.\n")
  const margins = () => (getCustom<unknown[]>("right-margin-functions") ?? []).length
  const before = margins()
  ctx.dispose()
  expect(margins()).toBe(before - 1)
  expect(editor.fontLock(editor.currentBuffer).some(s => String(s.face).startsWith("critique"))).toBe(false)
})
