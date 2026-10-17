import { describe, expect, test } from "bun:test"
import { parseInlineMarkdown } from "../../plugins/markdown/inline"

/** Each span as [covered text, face]. */
function render(src: string) {
  const { text, spans } = parseInlineMarkdown(src)
  return { text, spans: spans.map(s => [text.slice(s.start, s.end), s.face]) }
}

describe("parseInlineMarkdown", () => {
  test("strips emphasis, strong, strike, and code markers", () => {
    expect(render("a _b c_ **d** ~~e~~ `f*g*`")).toEqual({
      text: "a b c d e f*g*",
      spans: [
        ["b c", "markdown-emphasis"],
        ["d", "markdown-strong"],
        ["e", "markdown-strikethrough"],
        ["f*g*", "markdown-inline-code"],
      ],
    })
  })

  test("nests emphasis inside strong and the reverse", () => {
    expect(render("**a _b_**")).toEqual({
      text: "a b",
      spans: [["b", "markdown-emphasis"], ["a b", "markdown-strong"]],
    })
    expect(render("*a **b** c*").text).toBe("a b c")
  })

  test("links and wiki links keep only their label", () => {
    expect(render("see [docs](https://x.y) and [[Page|alias]] [[Other]]")).toEqual({
      text: "see docs and alias Other",
      spans: [["docs", "markdown-link"], ["alias", "markdown-link"], ["Other", "markdown-link"]],
    })
  })

  test("leaves non-markup alone", () => {
    expect(render("snake_case_name").text).toBe("snake_case_name")
    expect(render("2 * 3 * 4").text).toBe("2 * 3 * 4")
    expect(render("unclosed _em and `tick").text).toBe("unclosed _em and `tick")
    expect(render("\\_not em\\_").text).toBe("_not em_")
    expect(render("- was also in").text).toBe("- was also in")
  })
})
