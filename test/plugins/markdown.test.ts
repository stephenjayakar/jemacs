import { describe, expect, test } from "bun:test"
import { BufferModel } from "../../src/kernel/buffer"
import { buildDisplayModel } from "../../src/display/build-display-model"
import { pointFromWindowClick } from "../../src/display/click-to-point"
import { findPaneInModel } from "../../src/display/find-pane"
import { themedTextPlain } from "../../src/display/themed-text"
import { makeEditor } from "./helper"
import { keySeq } from "../harness"
import { FIXED_PITCH_FAMILY, getBufferFaceRemap, VARIABLE_PITCH_FAMILY } from "../../src/runtime/faces"
import { enterMode } from "../../src/modes/mode"
import {
  install,
  markdownCalcIndents,
  markdownDisplayFilter,
  markdownIndentLine,
  markdownParseHeadings,
  parseFencedCodeBlocks,
  MARKDOWN_FOLDED_LOCAL,
} from "../../plugins/markdown"
import { treeSitterFontLock } from "../../src/modes/tree-sitter"
import { registerTreeSitterGrammars } from "../../plugins/tree-sitter-grammars"

registerTreeSitterGrammars()

const DOC = [
  "# Top",
  "intro",
  "## Child",
  "body",
  "### Grand",
  "deep",
].join("\n")

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
