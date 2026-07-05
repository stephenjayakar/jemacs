import { describe, expect, test } from "bun:test"
import { BufferModel } from "../../src/kernel/buffer"
import { buildDisplayModel } from "../../src/display/build-display-model"
import { pointFromWindowClick } from "../../src/display/click-to-point"
import { findPaneInModel } from "../../src/display/find-pane"
import { themedTextPlain } from "../../src/display/themed-text"
import { makeEditor } from "./helper"
import { keySeq } from "../harness"
import { getCustom, setCustom } from "../../src/runtime/custom"
import { FIXED_PITCH_FAMILY, getBufferFaceRemap, VARIABLE_PITCH_FAMILY } from "../../src/runtime/faces"
import { enterMode } from "../../src/modes/mode"
import {
  install,
  markdownCalcIndents,
  markdownDisplayFilter,
  markdownIndentLine,
  markdownExportBuffer,
  markdownExportHtml,
  markdownParseHeadings,
  markdownTocBlockRange,
  markdownTocSlug,
  markdownTocText,
  markdownUndefinedReferenceLabels,
  parseFencedCodeBlocks,
  MARKDOWN_FOLDED_LOCAL,
} from "../../plugins/markdown"
import { treeSitterFontLock } from "../../src/modes/tree-sitter"
import { registerTreeSitterGrammars } from "../../plugins/tree-sitter-grammars"
import type { SpawnHandle, SpawnOptions } from "../../src/platform/runtime"

registerTreeSitterGrammars()

const DOC = [
  "# Top",
  "intro",
  "## Child",
  "body",
  "### Grand",
  "deep",
].join("\n")

function streamOf(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(enc.encode(text))
      ctrl.close()
    },
  })
}

function fakeSpawn(stdout: string, stderr = "", code = 0) {
  const calls: SpawnOptions[] = []
  const stdin: string[] = []
  const spawn = (opts: SpawnOptions): SpawnHandle => {
    calls.push(opts)
    return {
      stdin: opts.stdin === "pipe" ? { write: chunk => stdin.push(chunk), end: () => {} } : null,
      stdout: streamOf(stdout),
      stderr: streamOf(stderr),
      exited: Promise.resolve(code),
      kill: () => {},
    }
  }
  return { spawn, calls, stdin }
}

test("inferMode selects markdown and gfm from file names", () => {
  expect(new BufferModel({ name: "x.md" }).mode).toBe("markdown")
  expect(new BufferModel({ name: "README.md", path: "/proj/README.md" }).mode).toBe("gfm")
})

test("tree-sitter font-lock highlights markdown structure", () => {
  const text = "# Title\n\n**bold** and `code`\n\n> quote\n"
  const spans = treeSitterFontLock("markdown", new BufferModel({ name: "t.md", text, mode: "markdown" }))
  expect(spans.some(span => span.face === "type")).toBe(true)
  expect(spans.some(span => String(span.face) === "markdown-strong")).toBe(true)
  expect(spans.some(span => span.face === "comment")).toBe(true)
})

test("markdown emphasis uses italic face", () => {
  const editor = makeEditor()
  install(editor)
  const text = "plain *italic* text\n"
  const buffer = new BufferModel({ name: "t.md", text, mode: "markdown" })
  const spans = editor.fontLock(buffer)
  expect(spans.some(span => String(span.face) === "markdown-emphasis")).toBe(true)
})

test("markdown font-lock applies proportional header faces", () => {
  const editor = makeEditor()
  install(editor)
  const buffer = new BufferModel({ name: "doc.md", text: "# One\n## Two\nbody", mode: "text" })
  enterMode(buffer, "markdown")
  const spans = editor.fontLock(buffer)
  expect(spans.some(span => String(span.face) === "markdown-header-face-1")).toBe(true)
  expect(spans.some(span => String(span.face) === "markdown-header-face-2")).toBe(true)
})

test("markdown-indent-line follows previous list marker", () => {
  const text = "- item one\n"
  const buffer = new BufferModel({ name: "list.md", text, mode: "markdown" })
  buffer.point = text.length
  markdownIndentLine(buffer)
  expect(buffer.text).toBe("- item one\n  ")
})

test("markdownCalcIndents includes previous line indent", () => {
  const text = "    nested\n"
  const lineStart = text.indexOf("nested")
  const indents = markdownCalcIndents(text, lineStart)
  expect(indents).toContain(4)
})

test("markdownCalcIndents keeps previous line indent as the default candidate", () => {
  const text = "    parent\nchild\n"
  const lineStart = text.indexOf("child")
  expect(markdownCalcIndents(text, lineStart)[0]).toBe(4)
})

test("markdown-indent-line keeps point before indentation when outdenting whitespace", async () => {
  const editor = makeEditor()
  install(editor)
  const buffer = editor.scratch("doc.md", "    parent\n        \n", "markdown")
  const lineStart = buffer.text.indexOf("        ")
  buffer.point = lineStart

  await editor.run("markdown-outdent-or-delete")

  expect(buffer.text).toBe("    parent\n    \n")
  expect(buffer.point).toBe(lineStart)
})

test("markdown-mode keymap binds RET to jemacs-clear-whitespace-and-newline-and-indent", () => {
  const editor = makeEditor()
  install(editor)
  const buffer = new BufferModel({ name: "doc.md", text: "", mode: "markdown" })
  editor.addBuffer(buffer)
  editor.currentBufferId = buffer.id
  const result = editor.keymaps.lookup("return")
  expect(result.status).toBe("matched")
  expect(result.status === "matched" ? result.command : "").toBe("jemacs-clear-whitespace-and-newline-and-indent")
})

test("markdown-mode keymap binds Emacs movement and promotion arrows", () => {
  const editor = makeEditor()
  install(editor)
  const buffer = new BufferModel({ name: "doc.md", text: "", mode: "markdown" })
  editor.addBuffer(buffer)
  editor.currentBufferId = buffer.id

  expect(editor.keymaps.lookup("M-left")).toMatchObject({ status: "matched", command: "markdown-promote" })
  expect(editor.keymaps.lookup("M-right")).toMatchObject({ status: "matched", command: "markdown-demote" })
  expect(editor.keymaps.lookup("M-up")).toMatchObject({ status: "matched", command: "markdown-move-up" })
  expect(editor.keymaps.lookup("M-down")).toMatchObject({ status: "matched", command: "markdown-move-down" })
  expect(editor.keymaps.lookup("C-c left")).toMatchObject({ status: "matched", command: "markdown-promote" })
  expect(editor.keymaps.lookup("C-c down")).toMatchObject({ status: "matched", command: "markdown-move-down" })
  expect(editor.keymaps.lookup("C-c C-s t")).toMatchObject({ status: "matched", command: "markdown-insert-table" })
  expect(editor.keymaps.lookup("C-c C-s f")).toMatchObject({ status: "matched", command: "markdown-insert-footnote" })
  expect(editor.keymaps.lookup("C-c C-x [")).toMatchObject({ status: "matched", command: "markdown-insert-gfm-checkbox" })
  expect(editor.keymaps.lookup("C-c C-x C-x")).toMatchObject({ status: "matched", command: "markdown-toggle-gfm-checkbox" })
})

test("markdown-mode keymap binds Emacs export preview and reference commands under C-c C-c", () => {
  const editor = makeEditor()
  install(editor)
  const buffer = new BufferModel({ name: "doc.md", text: "", mode: "markdown" })
  editor.addBuffer(buffer)
  editor.currentBufferId = buffer.id

  expect(editor.keymaps.lookup("C-c C-c e")).toMatchObject({ status: "matched", command: "markdown-export" })
  expect(editor.keymaps.lookup("C-c C-c p")).toMatchObject({ status: "matched", command: "markdown-preview" })
  expect(editor.keymaps.lookup("C-c C-c o")).toMatchObject({ status: "matched", command: "markdown-open" })
  expect(editor.keymaps.lookup("C-c C-c c")).toMatchObject({ status: "matched", command: "markdown-check-refs" })
  expect(editor.keymaps.lookup("C-c C-o")).toMatchObject({ status: "matched", command: "markdown-follow-thing-at-point" })
})

test("markdown-check-refs finds undefined labels and ignores defined labels", () => {
  const text = [
    "[Defined][ok]",
    "[Missing][nope]",
    "[Also missing][other label]",
    "[Duplicate][nope]",
    "",
    "[ok]: https://example.com",
  ].join("\n")

  expect(markdownUndefinedReferenceLabels(text)).toEqual(["nope", "other label"])
})

test("markdown-toc helpers generate GitHub-style heading links", () => {
  const text = "# Top Title!\n\n## Child & More\nTitle Two\n---\n"
  expect(markdownTocSlug("Child & More")).toBe("child-more")
  expect(markdownTocText(text)).toBe([
    "<!-- markdown-toc start -->",
    "- [Top Title!](#top-title)",
    "  - [Child & More](#child-more)",
    "  - [Title Two](#title-two)",
    "<!-- markdown-toc end -->",
    "",
  ].join("\n"))
})

test("markdown-toc-generate-toc inserts at point and refresh replaces existing block", async () => {
  const editor = makeEditor()
  install(editor)
  const buffer = editor.scratch("doc.md", "# One\n\ntext\n## Two\n", "markdown")
  buffer.point = buffer.text.indexOf("text")
  await editor.run("markdown-toc-generate-toc")
  expect(buffer.text).toContain("<!-- markdown-toc start -->")
  expect(buffer.text).toContain("- [One](#one)")
  expect(buffer.text).toContain("  - [Two](#two)")
  const range = markdownTocBlockRange(buffer.text)
  expect(range).not.toBeNull()

  buffer.insert("\n### Three\n")
  await editor.run("markdown-toc-refresh-toc")
  expect(buffer.text.match(/markdown-toc start/g)).toHaveLength(1)
  expect(buffer.text).toContain("    - [Three](#three)")
})

test("markdown-narrow-to-subtree reports unsupported narrowing", async () => {
  const editor = makeEditor()
  install(editor)
  editor.scratch("doc.md", "# One\n", "markdown")
  let msg = ""
  editor.events.on("message", ({ text }) => { msg = text })
  await editor.run("markdown-narrow-to-subtree")
  expect(msg).toBe("Narrowing is not supported")
})

test("markdownExportHtml wraps processor output in a minimal escaped HTML skeleton", () => {
  expect(markdownExportHtml("a < b.md", "<h1>Title</h1>")).toBe([
    "<!doctype html>",
    "<html>",
    "<head>",
    "  <meta charset=\"utf-8\">",
    "  <title>a &lt; b.md</title>",
    "</head>",
    "<body>",
    "<h1>Title</h1>",
    "</body>",
    "</html>",
    "",
  ].join("\n"))
})

test("markdown-export dispatches through C-c C-c e using injected processor and writer", async () => {
  const editor = makeEditor()
  const { spawn, calls, stdin } = fakeSpawn("<p>Hello</p>\n")
  const writes: Array<{ path: string; text: string }> = []
  install(editor, { spawn, writeFile: async (path, text) => { writes.push({ path, text }) } })
  const buffer = new BufferModel({
    name: "doc.md",
    path: "/tmp/doc.md",
    text: "# Hello\n",
    mode: "markdown",
  })
  editor.addBuffer(buffer)
  editor.currentBufferId = buffer.id

  await keySeq(editor, "C-c", "C-c", "e")

  expect(calls).toHaveLength(1)
  expect(calls[0]?.cmd).toEqual(["sh", "-c", "markdown"])
  expect(stdin).toEqual(["# Hello\n"])
  expect(writes).toEqual([{
    path: "/tmp/doc.html",
    text: markdownExportHtml("doc.md", "<p>Hello</p>\n"),
  }])
})

test("markdownExportBuffer writes wrapped HTML with fake processor output", async () => {
  const { spawn, stdin } = fakeSpawn("<p>Body</p>")
  const writes: Array<{ path: string; text: string }> = []
  const buffer = new BufferModel({ name: "note.md", path: "/tmp/note.md", text: "Body", mode: "markdown" })

  const outputPath = await markdownExportBuffer(buffer, { spawn, writeFile: async (path, text) => { writes.push({ path, text }) } })

  expect(outputPath).toBe("/tmp/note.html")
  expect(stdin).toEqual(["Body"])
  expect(writes[0]?.text).toBe(markdownExportHtml("note.md", "<p>Body</p>"))
})

test("markdown-mode onEnter applies proportional default face remap", () => {
  const editor = makeEditor()
  install(editor)
  const buffer = new BufferModel({ name: "doc.md", text: "# Title", mode: "text" })
  enterMode(buffer, "markdown")
  expect(getBufferFaceRemap(buffer, "default")?.family).toBe(VARIABLE_PITCH_FAMILY)
  expect(getBufferFaceRemap(buffer, "default")?.height).toBeUndefined()
  expect(getBufferFaceRemap(buffer, "string")?.family).toBe(FIXED_PITCH_FAMILY)
})

describe("markdown-cycle", () => {
  test("TAB cycles through sorted unique indent positions on plain lines", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("doc.md", "    parent\nchild\n", "markdown")
    buffer.point = buffer.text.indexOf("child")

    await keySeq(editor, "TAB")
    expect(buffer.text).toBe("    parent\n    child\n")
    expect(buffer.point).toBe(buffer.text.indexOf("child"))

    await keySeq(editor, "TAB")
    expect(buffer.text).toBe("    parent\n        child\n")
    expect(buffer.point).toBe(buffer.text.indexOf("child"))

    await keySeq(editor, "TAB")
    expect(buffer.text).toBe("    parent\nchild\n")
    expect(buffer.point).toBe(buffer.text.indexOf("child"))
  })

  test("first TAB on a plain child line defaults to previous line indentation", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("doc.md", "    parent\nchild\n", "markdown")
    buffer.point = buffer.text.indexOf("child")

    await keySeq(editor, "TAB")

    expect(buffer.text).toBe("    parent\n    child\n")
  })

  test("TAB on heading folds subtree instead of indenting", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("doc.md", DOC, "markdown")
    buffer.point = 0
    await editor.run("markdown-cycle")
    const folded = buffer.locals.get(MARKDOWN_FOLDED_LOCAL) as Array<[number, number]>
    expect(folded?.length).toBeGreaterThan(0)
    expect(buffer.text).toBe(DOC)
    expect(buffer.text.startsWith("    # Top")).toBe(false)
  })

  test("TAB on ATX heading does not indent the heading line", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("doc.md", "# Title\n", "markdown")
    buffer.point = 0
    await keySeq(editor, "tab")
    expect(buffer.text).toBe("# Title\n")
  })
})

describe("markdownParseHeadings", () => {
  test("parses ATX and setext headings", () => {
    const text = "# One\n\nTitle\n---\n\n## Two\n"
    const hs = markdownParseHeadings(text)
    expect(hs.map(h => [h.level, h.title])).toEqual([
      [1, "One"],
      [2, "Title"],
      [2, "Two"],
    ])
  })
})

describe("markdown pipe tables", () => {
  test("markdown-table-align normalizes widths, delimiter markers, and indentation", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("table.md", "  Name|Age|City\n  :--|--:|:-:\n  Ann|9|New York\n  A\\|B|10|LA\n", "markdown")
    buffer.point = buffer.text.indexOf("Ann")

    await editor.run("markdown-table-align")

    expect(buffer.text).toBe([
      "  | Name | Age | City     |",
      "  | :--- | --: | :------: |",
      "  | Ann  | 9   | New York |",
      "  | A\\|B | 10  | LA       |",
      "",
    ].join("\n"))
    expect(buffer.text.slice(buffer.point, buffer.point + 3)).toBe("Ann")
  })

  test("forward and backward cell movement align first and skip delimiter rows", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("table.md", "|Name|Age|\n|---|---|\n|Ann|9|\n", "markdown")
    buffer.point = buffer.text.indexOf("Name")

    await editor.run("markdown-table-forward-cell")
    expect(buffer.text).toBe("| Name | Age |\n| ---- | --- |\n| Ann  | 9   |\n")
    expect(buffer.text.slice(buffer.point, buffer.point + 3)).toBe("Age")

    await editor.run("markdown-table-forward-cell")
    expect(buffer.text.slice(buffer.point, buffer.point + 3)).toBe("Ann")

    await editor.run("markdown-table-backward-cell")
    expect(buffer.text.slice(buffer.point, buffer.point + 3)).toBe("Age")
  })

  test("TAB on the last table cell creates a new empty row", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("table.md", "| A | B |\n| --- | --- |\n| 1 | 2 |\n", "markdown")
    buffer.point = buffer.text.indexOf("2")

    await keySeq(editor, "TAB")

    expect(buffer.text).toBe("| A   | B   |\n| --- | --- |\n| 1   | 2   |\n|     |     |\n")
    expect(buffer.lineCol().line).toBe(4)
    expect(buffer.lineCol().col).toBe(3)
  })

  test("markdown-insert-table prompts for rows and columns", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("table.md", "", "markdown")
    const prompts: string[] = []
    const answers = ["2", "3"]
    editor.prompt = async prompt => {
      prompts.push(prompt)
      return answers.shift() ?? null
    }

    await editor.run("markdown-insert-table")

    expect(prompts).toEqual(["Rows: ", "Columns: "])
    expect(buffer.text).toBe("|     |     |     |\n| --- | --- | --- |\n|     |     |     |")
  })

  test("inserts and deletes table rows", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("table.md", "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n", "markdown")
    buffer.point = buffer.text.indexOf("3")

    await editor.run("markdown-table-insert-row")
    expect(buffer.text).toBe("| A   | B   |\n| --- | --- |\n| 1   | 2   |\n|     |     |\n| 3   | 4   |\n")

    await editor.run("markdown-table-delete-row")
    expect(buffer.text).toBe("| A   | B   |\n| --- | --- |\n| 1   | 2   |\n| 3   | 4   |\n")
  })

  test("inserts and deletes table columns", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("table.md", "| A | B |\n| --- | --- |\n| 1 | 2 |\n", "markdown")
    buffer.point = buffer.text.indexOf("B")

    await editor.run("markdown-table-insert-column")
    expect(buffer.text).toBe("| A   |     | B   |\n| --- | --- | --- |\n| 1   |     | 2   |\n")

    await editor.run("markdown-table-delete-column")
    expect(buffer.text).toBe("| A   | B   |\n| --- | --- |\n| 1   | 2   |\n")
  })

  test("moves table rows and columns", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("table.md", "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n", "markdown")
    buffer.point = buffer.text.indexOf("3")

    await editor.run("markdown-table-move-row-up")
    expect(buffer.text).toBe("| A   | B   |\n| --- | --- |\n| 3   | 4   |\n| 1   | 2   |\n")

    buffer.point = buffer.text.indexOf("B")
    await editor.run("markdown-table-move-column-left")
    expect(buffer.text).toBe("| B   | A   |\n| --- | --- |\n| 4   | 3   |\n| 2   | 1   |\n")
  })

  test("DWIM arrows move table rows and columns but keep heading behavior outside tables", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("doc.md", "# A\na\n# B\nb\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n", "markdown")
    buffer.point = buffer.text.indexOf("3")

    await keySeq(editor, "M-up")
    expect(buffer.text).toContain("| 3   | 4   |\n| 1   | 2   |")

    // indexOf("B") alone would land on the "# B" heading, not the table cell.
    buffer.point = buffer.text.indexOf("B", buffer.text.indexOf("|"))
    await keySeq(editor, "C-c", "left")
    expect(buffer.text).toContain("| B   | A   |")

    buffer.point = buffer.text.indexOf("# B")
    await keySeq(editor, "M-up")
    // Heading B's subtree includes the table below it, so both move above A.
    expect(buffer.text.startsWith("# B\nb\n")).toBe(true)
    expect(buffer.text.endsWith("# A\na\n")).toBe(true)
  })
})

describe("markdown promote/demote parity", () => {
  test("promotes and demotes ATX headings without crossing level bounds", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("doc.md", "## Title\n", "markdown")
    buffer.point = 0

    await editor.run("markdown-promote")
    expect(buffer.text).toBe("# Title\n")
    await editor.run("markdown-promote")
    expect(buffer.text).toBe("# Title\n")
    await editor.run("markdown-demote")
    expect(buffer.text).toBe("## Title\n")
  })

  test("promotes and demotes setext headings through setext and ATX forms", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("doc.md", "Title\n---\n", "markdown")
    buffer.point = buffer.text.indexOf("---")

    await editor.run("markdown-promote")
    expect(buffer.text).toBe("Title\n===\n")
    await editor.run("markdown-promote")
    expect(buffer.text).toBe("Title\n===\n")
    await editor.run("markdown-demote")
    expect(buffer.text).toBe("Title\n---\n")
    await editor.run("markdown-demote")
    expect(buffer.text).toBe("### Title\n")
  })

  test("promotes and demotes list items by markdown list indent width", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("doc.md", "- one\n- two\n", "markdown")
    buffer.point = buffer.text.indexOf("- two")

    await editor.run("markdown-demote")
    expect(buffer.text).toBe("- one\n    - two\n")
    await editor.run("markdown-promote")
    expect(buffer.text).toBe("- one\n- two\n")
  })

  test("promotes and demotes heading subtrees", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("doc.md", "## A\n### B\ntext\n## C\n", "markdown")
    buffer.point = 0

    await editor.run("markdown-promote-subtree")
    expect(buffer.text).toBe("# A\n## B\ntext\n## C\n")
    // After promotion, "## C" is now inside "# A"'s subtree, so demoting
    // the subtree at "# A" demotes it too.
    await editor.run("markdown-demote-subtree")
    expect(buffer.text).toBe("## A\n### B\ntext\n### C\n")
  })

  test("refuses subtree edits that would cross heading bounds", async () => {
    const editor = makeEditor()
    install(editor)
    const promote = editor.scratch("promote.md", "# A\n## B\n", "markdown")
    promote.point = 0
    await editor.run("markdown-promote-subtree")
    expect(promote.text).toBe("# A\n## B\n")

    const demote = editor.scratch("demote.md", "## A\n###### B\n", "markdown")
    demote.point = 0
    await editor.run("markdown-demote-subtree")
    expect(demote.text).toBe("## A\n###### B\n")
  })
})

describe("markdown subtree and list movement", () => {
  test("moves heading subtrees up and down across same-level siblings", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("doc.md", "# A\na\n## A1\nx\n# B\nb\n# C\nc\n", "markdown")
    buffer.point = buffer.text.indexOf("# B")

    await editor.run("markdown-move-subtree-up")
    expect(buffer.text).toBe("# B\nb\n# A\na\n## A1\nx\n# C\nc\n")
    await editor.run("markdown-move-subtree-down")
    expect(buffer.text).toBe("# A\na\n## A1\nx\n# B\nb\n# C\nc\n")
  })

  test("DWIM move commands move heading subtrees", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("doc.md", "# A\na\n# B\nb\n", "markdown")
    buffer.point = buffer.text.indexOf("# B")

    await editor.run("markdown-move-up")
    expect(buffer.text).toBe("# B\nb\n# A\na\n")
    await editor.run("markdown-move-down")
    expect(buffer.text).toBe("# A\na\n# B\nb\n")
  })

  test("moves list items with nested children up and down", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("doc.md", "- one\n    - one child\n- two\n    continued\n- three\n", "markdown")
    buffer.point = buffer.text.indexOf("- two")

    await editor.run("markdown-move-list-item-up")
    expect(buffer.text).toBe("- two\n    continued\n- one\n    - one child\n- three\n")
    await editor.run("markdown-move-list-item-down")
    expect(buffer.text).toBe("- one\n    - one child\n- two\n    continued\n- three\n")
  })

  test("DWIM move commands move list items", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("doc.md", "- one\n- two\n", "markdown")
    buffer.point = buffer.text.indexOf("- two")

    await editor.run("markdown-move-up")
    expect(buffer.text).toBe("- two\n- one\n")
    await editor.run("markdown-move-down")
    expect(buffer.text).toBe("- one\n- two\n")
  })
})

describe("markdown list and checkbox commands", () => {
  test("markdown-insert-gfm-checkbox adds a checkbox to a non-empty list item", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("todo.md", "- task\n", "markdown")
    buffer.point = buffer.text.indexOf("task")

    await editor.run("markdown-insert-gfm-checkbox")

    expect(buffer.text).toBe("- [ ] task\n")
  })

  test("markdown-insert-gfm-checkbox makes a non-list line into a checkbox item", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("todo.md", "task\n", "markdown")
    buffer.point = buffer.text.indexOf("task")

    await editor.run("markdown-insert-gfm-checkbox")

    expect(buffer.text).toBe("- [ ] task\n")
  })

  test("markdown-insert-gfm-checkbox inserts a new checkbox item from an existing checkbox", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("todo.md", "- [x] done\n", "markdown")
    buffer.point = buffer.text.indexOf("\n")

    await editor.run("markdown-insert-gfm-checkbox")

    expect(buffer.text).toBe("- [x] done\n- [ ] \n")
  })

  test("markdown-toggle-gfm-checkbox toggles checked and unchecked boxes", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("todo.md", "- [ ] task\n- [x] done\n", "markdown")
    buffer.point = buffer.text.indexOf("task")

    await editor.run("markdown-toggle-gfm-checkbox")
    expect(buffer.text).toBe("- [x] task\n- [x] done\n")

    buffer.point = buffer.text.indexOf("done")
    await editor.run("markdown-toggle-gfm-checkbox")
    expect(buffer.text).toBe("- [x] task\n- [ ] done\n")
  })

  test("markdown-cleanup-list-numbers renumbers ordered lists by nesting level", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch(
      "list.md",
      "3. one\n    8. child\n    9. child\n4. two\n\n9. other\n    4. nested\n10. other\n",
      "markdown",
    )

    await editor.run("markdown-cleanup-list-numbers")

    expect(buffer.text).toBe("1. one\n    1. child\n    2. child\n2. two\n\n1. other\n    1. nested\n2. other\n")
  })

  test("markdown-insert-list-item continues and renumbers ordered list siblings", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("list.md", "1. one\n2. two\n3. three\n", "markdown")
    buffer.point = buffer.text.indexOf("\n")

    await editor.run("markdown-insert-list-item")

    expect(buffer.text).toBe("1. one\n2. \n3. two\n4. three\n")
  })
})

describe("markdownDisplayFilter", () => {
  test("collapses folded line ranges with ellipsis", () => {
    const buffer = new BufferModel({ name: "doc.md", text: DOC, mode: "markdown" })
    buffer.locals.set(MARKDOWN_FOLDED_LOCAL, [[1, 5]])
    const result = markdownDisplayFilter(buffer)
    expect(result?.text).toContain("# Top")
    expect(result?.text).toContain("...")
    expect(result?.text).not.toContain("deep")
  })

  test("hides ATX header and emphasis markup when markdown-hide-markup is on", () => {
    const buffer = new BufferModel({
      name: "doc.md",
      text: "# Title\nSome **bold** text\n",
      mode: "markdown",
    })
    buffer.locals.set("markdown-hide-markup", true)
    const result = markdownDisplayFilter(buffer)
    expect(result?.text).toBe("Title\nSome bold text\n")
    expect(buffer.text).toBe("# Title\nSome **bold** text\n")
  })

  test("reuses the hidden-markup filter cache when there are no folded ranges", () => {
    const buffer = new BufferModel({
      name: "doc.md",
      text: "# Title\nSome **bold** text\n",
      mode: "markdown",
    })
    buffer.locals.set("markdown-hide-markup", true)
    const first = markdownDisplayFilter(buffer)
    const second = markdownDisplayFilter(buffer)
    expect(second).toBe(first)
  })

  test("hides inline code backticks when markdown-hide-markup is on", () => {
    const buffer = new BufferModel({
      name: "doc.md",
      text: "Use `hello` here\n",
      mode: "markdown",
    })
    buffer.locals.set("markdown-hide-markup", true)
    const result = markdownDisplayFilter(buffer)
    expect(result?.text).toBe("Use hello here\n")
    expect(result?.text).not.toContain("`")
  })

  test("hides fenced code delimiter lines when markdown-hide-markup is on", () => {
    const buffer = new BufferModel({
      name: "doc.md",
      text: "Before\n\n```typescript\nconst x = 1\n```\nAfter\n",
      mode: "markdown",
    })
    buffer.locals.set("markdown-hide-markup", true)
    const result = markdownDisplayFilter(buffer)
    expect(result?.text).toBe("Before\n\nconst x = 1\n\nAfter\n")
    expect(result?.text).not.toContain("```")
  })

  test("composes link URLs when markdown-hide-urls is on", () => {
    const buffer = new BufferModel({
      name: "doc.md",
      text: "[link](https://example.com)\n",
      mode: "markdown",
    })
    buffer.locals.set("markdown-hide-markup", true)
    buffer.locals.set("markdown-hide-urls", true)
    const result = markdownDisplayFilter(buffer)
    expect(result?.text).toBe("link↪\n")
  })

  test("unmaps hidden markup display columns back to buffer points", () => {
    const buffer = new BufferModel({
      name: "doc.md",
      text: "# Title\nSome **bold** text\n",
      mode: "markdown",
    })
    buffer.locals.set("markdown-hide-markup", true)
    const result = markdownDisplayFilter(buffer)!
    const displayPoint = result.text.indexOf("bold")
    expect(result.unmap?.(displayPoint)).toBe(buffer.text.indexOf("bold"))
    expect(result.map(buffer.text.indexOf("bold"))).toBe(displayPoint)
  })
})

describe("markdown mouse clicks", () => {
  test("clicking a task checkbox toggles it", () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("todo.md", "- [ ] task\n- [x] done\n", "markdown")
    const firstCheck = buffer.text.indexOf("[ ]") + 1

    editor.clickWindow(editor.selectedWindowId, firstCheck)

    expect(buffer.text).toBe("- [x] task\n- [x] done\n")
  })

  test("click hit-testing accounts for hidden markup and centered visual fill", () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("doc.md", "# Title\nSome **bold** text\n", "markdown")
    buffer.locals.set("markdown-hide-markup", true)
    buffer.locals.set("markdown-visual-fill-column-mode", true)
    buffer.locals.set("markdown-fill-column", 20)
    buffer.locals.set("markdown-visual-fill-column-center-text", true)
    const model = buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 24, cols: 40 } })
    const pane = findPaneInModel(model.windows, editor.selectedWindowId)!
    const displayBoldCol = "Some ".length
    const point = pointFromWindowClick(
      buffer.text,
      pane.clickState,
      1,
      pane.clickState.gutterPrefixLen + (pane.clickState.leftPadding ?? 0) + displayBoldCol,
      pane.bodyLineBudget,
    )

    expect(point).toBe(buffer.text.indexOf("bold"))
  })
})

test("markdown isearch treats [ as a literal character", async () => {
  const editor = makeEditor()
  install(editor)
  const buffer = editor.scratch("doc.md", "before [link](url)\n", "markdown")
  buffer.point = 0

  await keySeq(editor, "C-s", "[")

  expect(editor.isearch?.string).toBe("[")
  expect(buffer.point).toBe(buffer.text.indexOf("[") + 1)
})

test("markdown isearch owns the minibuffer row while markup hiding is active", async () => {
  const editor = makeEditor()
  install(editor)
  const buffer = editor.scratch("doc.md", "before [link](url)\n", "markdown")
  buffer.locals.set("markdown-hide-markup", true)
  buffer.point = 0

  await keySeq(editor, "C-s", "[")
  const model = buildDisplayModel(editor, { lastMessage: "I-search: [", viewport: { rows: 24, cols: 80 } })

  expect(editor.isearch?.string).toBe("[")
  expect(buffer.point).toBe(buffer.text.indexOf("[") + 1)
  expect(themedTextPlain(model.minibuffer)).toContain("I-search: [")
  expect(themedTextPlain(model.echo)).not.toContain("I-search")
})

describe("markdown-toggle-markup-hiding", () => {
  test("toggles buffer-local markdown-hide-markup", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("doc.md", "# Hi\n", "markdown")
    await editor.run("markdown-toggle-markup-hiding")
    expect(buffer.locals.get("markdown-hide-markup")).toBe(true)
    expect(markdownDisplayFilter(buffer)?.text).toBe("Hi\n")
    await editor.run("markdown-toggle-markup-hiding")
    expect(buffer.locals.get("markdown-hide-markup")).toBe(false)
    expect(markdownDisplayFilter(buffer)).toBeNull()
  })
})

describe("parseFencedCodeBlocks", () => {
  test("parses GFM fenced blocks with language info", () => {
    const text = "```typescript\nconst x = 1\n```\n"
    const blocks = parseFencedCodeBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.lang).toBe("typescript")
    expect(text.slice(blocks[0]!.bodyStart, blocks[0]!.bodyEnd)).toBe("const x = 1\n")
  })
})

describe("markdown-fontify-code-blocks-natively", () => {
  test("highlights fenced typescript when native fontification is enabled", () => {
    const editor = makeEditor()
    install(editor)
    const buffer = new BufferModel({
      name: "doc.md",
      text: "```typescript\nconst n: number = 1\n```\n",
      mode: "markdown",
    })
    buffer.locals.set("markdown-fontify-code-blocks-natively", true)
    const spans = editor.fontLock(buffer)
    expect(spans.some(span => span.face === "keyword" || span.face === "type" || span.face === "number")).toBe(true)
  })

  test("markdown-toggle-fontify-code-blocks-natively toggles buffer-local state", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("doc.md", "```js\nx\n```\n", "markdown")
    // Toggle is relative to the current effective value (global default may have
    // been set by another test's installStephenConfig).
    await editor.run("markdown-toggle-fontify-code-blocks-natively")
    const after1 = buffer.locals.get("markdown-fontify-code-blocks-natively")
    expect(typeof after1).toBe("boolean")
    await editor.run("markdown-toggle-fontify-code-blocks-natively")
    expect(buffer.locals.get("markdown-fontify-code-blocks-natively")).toBe(!after1)
  })
})

describe("markdown-view-mode", () => {
  test("onEnter enables markup hiding by default", () => {
    const editor = makeEditor()
    install(editor)
    const buffer = new BufferModel({ name: "doc.md", text: "# Title\n", mode: "text" })
    enterMode(buffer, "markdown-view-mode")
    expect(buffer.mode).toBe("markdown-view-mode")
    expect(buffer.locals.get("markdown-hide-markup")).toBe(true)
    expect(markdownDisplayFilter(buffer)?.text).toBe("Title\n")
  })
})

describe("jemacs-clear-whitespace-and-newline-and-indent", () => {
  test("trims trailing whitespace on the line above after RET", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("doc.md", "line with spaces   ", "markdown")
    buffer.point = buffer.text.length
    await editor.run("jemacs-clear-whitespace-and-newline-and-indent")
    expect(buffer.text).toBe("line with spaces\n")
  })
})

describe("markdown-insert-link", () => {
  test("C-c C-l dispatches link insertion in markdown-mode", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("doc.md", "", "markdown")
    const answers = ["https://example.com", "Example"]
    editor.prompt = async () => answers.shift() ?? null

    await keySeq(editor, "C-c", "C-l")

    expect(buffer.text).toBe("[Example](https://example.com)")
  })

  test("prompts for URL and link text before inserting", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("doc.md", "text\n", "markdown")
    const prompts: string[] = []
    const answers = ["https://example.com", "Example"]
    editor.prompt = async prompt => {
      prompts.push(prompt)
      return answers.shift() ?? null
    }

    await editor.run("markdown-insert-link")

    expect(prompts).toEqual(["URL or [reference]: ", "Link text: "])
    expect(buffer.text).toBe("[Example](https://example.com)text\n")
    expect(buffer.point).toBe("[Example](https://example.com)".length)
  })

  test("uses active region as link text", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("doc.md", "read more\n", "markdown")
    buffer.point = 0
    buffer.setMark()
    buffer.point = 4
    const prompts: string[] = []
    editor.prompt = async prompt => {
      prompts.push(prompt)
      return "https://example.com"
    }

    await editor.run("markdown-insert-link")

    expect(prompts).toEqual(["URL or [reference]: "])
    expect(buffer.text).toBe("[read](https://example.com) more\n")
    expect(buffer.markActive).toBe(false)
  })
})

describe("markdown footnotes", () => {
  test("markdown-insert-footnote inserts marker, appends definition, and picks next number", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("doc.md", "alpha ", "markdown")
    buffer.point = buffer.text.length

    await editor.run("markdown-insert-footnote")

    expect(buffer.text).toBe("alpha [^1]\n\n[^1]: ")
    expect(buffer.point).toBe(buffer.text.length)

    buffer.point = "alpha ".length
    await editor.run("markdown-insert-footnote")

    expect(buffer.text).toBe("alpha [^2][^1]\n\n[^1]: \n\n[^2]: ")
    expect(buffer.point).toBe(buffer.text.length)
  })

  test("markdown-footnote-goto-text and markdown-footnote-return round trip", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("doc.md", "alpha [^1]\n\n[^1]: note\n", "markdown")
    const marker = buffer.text.indexOf("[^1]")
    buffer.point = marker + 1

    await editor.run("markdown-footnote-goto-text")
    expect(buffer.point).toBe(buffer.text.indexOf("note"))

    await editor.run("markdown-footnote-return")
    expect(buffer.point).toBe(marker)
  })
})

describe("markdown reference links", () => {
  test("markdown-insert-reference-link-dwim appends a new definition after the current paragraph", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("doc.md", "Para one.\n\nNext.\n", "markdown")
    buffer.point = "Para".length
    const prompts: string[] = []
    const answers = ["Example", "ex", "https://example.com"]
    editor.prompt = async (prompt, initial) => {
      prompts.push(`${prompt}${initial ? `[${initial}]` : ""}`)
      return answers.shift() ?? null
    }

    await editor.run("markdown-insert-reference-link-dwim")

    expect(prompts).toEqual(["Link text: ", "Label: [Example]", "URL: "])
    expect(buffer.text).toBe("Para[Example][ex] one.\n\n[ex]: https://example.com\n\nNext.\n")
    expect(buffer.point).toBe("Para[Example][ex]".length)
  })

  test("markdown-insert-reference-link-dwim reuses an existing definition", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("doc.md", "Para \n\n[ex]: https://old.example\n", "markdown")
    buffer.point = "Para ".length
    const answers = ["Example", "ex", "https://new.example"]
    editor.prompt = async () => answers.shift() ?? null

    await editor.run("markdown-insert-reference-link-dwim")

    expect(buffer.text).toBe("Para [Example][ex]\n\n[ex]: https://old.example\n")
  })

  test("markdown-next-link and follow-thing-at-point recognize reference links", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("doc.md", "start\n[Example][ex]\n\n[ex]: https://example.com\n", "markdown")
    buffer.point = 0

    await editor.run("markdown-next-link")
    expect(buffer.point).toBe(buffer.text.indexOf("[Example][ex]"))

    await editor.run("markdown-follow-thing-at-point")
    expect(buffer.point).toBe(buffer.text.indexOf("[ex]: https://example.com"))
  })

  test("font-lock marks reference links with markdown-link face", () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("doc.md", "[Example][ex]\n\n[ex]: https://example.com\n", "markdown")

    const spans = editor.fontLock(buffer)

    expect(spans.some(span => String(span.face) === "markdown-link" && span.start === 0)).toBe(true)
  })
})

describe("markdown-outdent-or-delete", () => {
  test("backspace on an empty line joins with the previous line", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("doc.md", "one\n\ntwo\n", "markdown")
    buffer.point = "one\n".length
    await keySeq(editor, "backspace")
    expect(buffer.text).toBe("one\ntwo\n")
    expect(buffer.point).toBe("one".length)
  })
})

describe("markdown-edit-code-block", () => {
  const DOC = "# Title\n\n```python\nprint(1)\n```\n\ntail\n"

  test("open, edit, commit replaces exactly the block body", async () => {
    const editor = makeEditor()
    install(editor)
    const source = editor.scratch("doc.md", DOC, "markdown")
    source.point = source.text.indexOf("print")

    await editor.run("markdown-edit-code-block")
    const edit = editor.currentBuffer
    expect(edit.name).toBe("*edit code block: python*")
    expect(edit.text).toBe("print(1)\n")

    edit.setText("print(2)\nprint(3)")
    await editor.run("edit-indirect-commit")
    expect(source.text).toBe("# Title\n\n```python\nprint(2)\nprint(3)\n```\n\ntail\n")
    expect(editor.currentBuffer).toBe(source)
    expect([...editor.buffers.values()].some(b => b.name.startsWith("*edit code block"))).toBe(false)
  })

  test("abort leaves the source unchanged", async () => {
    const editor = makeEditor()
    install(editor)
    const source = editor.scratch("doc.md", DOC, "markdown")
    source.point = source.text.indexOf("print")

    await editor.run("markdown-edit-code-block")
    editor.currentBuffer.setText("garbage")
    await editor.run("edit-indirect-abort")
    expect(source.text).toBe(DOC)
  })

  test("source edits above the block still commit to the right place", async () => {
    const editor = makeEditor()
    install(editor)
    const source = editor.scratch("doc.md", DOC, "markdown")
    source.point = source.text.indexOf("print")

    await editor.run("markdown-edit-code-block")
    const edit = editor.currentBuffer
    source.replaceRange(0, 0, "intro line\n")
    edit.setText("print(9)\n")
    await editor.run("edit-indirect-commit")
    expect(source.text).toBe("intro line\n# Title\n\n```python\nprint(9)\n```\n\ntail\n")
  })

  test("committing after the block itself was edited is refused", async () => {
    const editor = makeEditor()
    install(editor)
    const source = editor.scratch("doc.md", DOC, "markdown")
    source.point = source.text.indexOf("print")

    await editor.run("markdown-edit-code-block")
    const edit = editor.currentBuffer
    const start = source.text.indexOf("print(1)")
    source.replaceRange(start, start + "print(1)".length, "changed()")
    edit.setText("print(9)\n")
    await editor.run("edit-indirect-commit")
    expect(source.text).toContain("changed()")
    expect(source.text).not.toContain("print(9)")
  })
})

describe("markdown inline images and live preview", () => {
  test("markdown-toggle-inline-images flips the display option", async () => {
    const editor = makeEditor()
    install(editor)
    setCustom("markdown-display-inline-images", true)
    await editor.run("markdown-toggle-inline-images")
    expect(getCustom<boolean>("markdown-display-inline-images")).toBe(false)
    await editor.run("markdown-toggle-inline-images")
    expect(getCustom<boolean>("markdown-display-inline-images")).toBe(true)
  })

  test("markdown-live-preview-mode exports on enable and after saves", async () => {
    const editor = makeEditor()
    const { spawn } = fakeSpawn("<p>v1</p>")
    const writes: Array<{ path: string; text: string }> = []
    const opened: string[] = []
    install(editor, {
      spawn,
      writeFile: async (path, text) => { writes.push({ path, text }) },
      openExternal: url => { opened.push(url) },
    })
    const buffer = new BufferModel({ name: "doc.md", path: "/tmp/doc.md", text: "# v1\n", mode: "markdown" })
    editor.addBuffer(buffer)
    editor.currentBufferId = buffer.id

    await editor.run("markdown-live-preview-mode")
    expect(writes).toHaveLength(1)
    expect(opened).toHaveLength(1)

    await editor.runHook("after-save-hook", buffer)
    expect(writes).toHaveLength(2)
    expect(writes[1]!.path).toBe(writes[0]!.path)
    // Opened only once; saves refresh the file in place.
    expect(opened).toHaveLength(1)

    await editor.run("markdown-live-preview-mode")
    await editor.runHook("after-save-hook", buffer)
    expect(writes).toHaveLength(2)
  })
})
