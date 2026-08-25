import { expect, test } from "bun:test"
import { BufferModel } from "../../src/kernel/buffer"
import { getMode, modeFeature, type TextSpan } from "../../src/modes/mode"
import { bibtexFontLock, bibtexImenuIndex, installTexModes, latexFontLock, latexImenuIndex, latexIndentLine, texFontLock, texIndentLine } from "../../src/modes/tex"

function expectSpan(text: string, spans: TextSpan[], needle: string, face: TextSpan["face"]): void {
  const start = text.indexOf(needle)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(spans).toContainEqual({ start, end: start + needle.length, face })
}

test("TeX-family modes register GNU mode names", () => {
  installTexModes()

  expect(getMode("tex-mode")?.parent).toBe("text")
  expect(getMode("tex-mode")?.commentStart).toBe("%")
  expect(getMode("latex-mode")?.parent).toBe("tex-mode")
  expect(getMode("latex-mode")?.commentStart).toBe("%")
  expect(getMode("plain-tex-mode")?.parent).toBe("tex-mode")
  expect(getMode("bibtex-mode")?.parent).toBe("text")
  expect(getMode("bibtex-mode")?.commentStart).toBe("%")
  expect(modeFeature("plain-tex-mode", "fontLock")).toBe(texFontLock)
  expect(modeFeature("latex-mode", "indentLine")).toBe(latexIndentLine)
  expect(modeFeature("bibtex-mode", "indentLine")).toBe(texIndentLine)
})

test("latex-mode font-lock highlights TeX and LaTeX constructs", () => {
  installTexModes()
  const text = [
    "% top comment",
    "\\documentclass{article}",
    "\\usepackage{amsmath}",
    "\\begin{abstract}",
    "\\section{Introduction}",
    "Equation $x + y$ and $$z^2$$.",
    "\\label{sec:intro}",
    "See \\ref{sec:intro} and \\cite{knuth84}.",
    "a & b \\\\",
    "\\end{abstract}",
  ].join("\n")
  const buffer = new BufferModel({ name: "paper.tex", text, mode: "latex-mode" })
  const spans = latexFontLock(buffer)

  expectSpan(text, spans, "% top comment", "comment")
  expectSpan(text, spans, "\\documentclass", "keyword")
  expectSpan(text, spans, "article", "string")
  expectSpan(text, spans, "\\usepackage", "keyword")
  expectSpan(text, spans, "amsmath", "string")
  expectSpan(text, spans, "abstract", "type")
  expectSpan(text, spans, "\\section", "keyword")
  expectSpan(text, spans, "Introduction", "function")
  expectSpan(text, spans, "$x + y$", "string")
  expectSpan(text, spans, "$$z^2$$", "string")
  expectSpan(text, spans, "sec:intro", "constant")
  expectSpan(text, spans, "knuth84", "constant")
  expectSpan(text, spans, "&", "builtin")
  expectSpan(text, spans, "\\\\", "builtin")

  const ranged = latexFontLock(buffer, { startLine: 3, endLine: 6, start: buffer.lineStarts[3]!, end: buffer.lineStarts[6]! })
  expect(ranged.some(span => text.slice(span.start, span.end) === "% top comment")).toBe(false)
  expectSpan(text, ranged, "abstract", "type")
  expectSpan(text, ranged, "Introduction", "function")
})

test("latex-mode imenu indexes sectioning commands", () => {
  const text = [
    "\\section{Introduction}",
    "% \\section{Ignored}",
    "\\subsection{Details}",
  ].join("\n")
  const buffer = new BufferModel({ name: "paper.tex", text, mode: "latex-mode" })

  expect(latexImenuIndex(buffer)).toEqual([
    { name: "Introduction", point: text.indexOf("\\section") },
    { name: "Details", point: text.indexOf("\\subsection") },
  ])
})

test("latex-mode indentation indents inside environments", () => {
  const buffer = new BufferModel({ name: "paper.tex", text: "\\begin{document}\nBody\n  \\end{document}\n", mode: "latex-mode" })

  buffer.point = buffer.text.indexOf("Body")
  latexIndentLine(buffer)
  expect(buffer.text).toContain("\\begin{document}\n  Body\n")

  buffer.point = buffer.text.indexOf("\\end")
  latexIndentLine(buffer)
  expect(buffer.text).toContain("  Body\n\\end{document}\n")
})

test("bibtex-mode font-lock highlights entries, fields, values, and comments", () => {
  installTexModes()
  const text = [
    "% bibliography",
    "@article{knuth84,",
    "  author = {Donald E. Knuth},",
    "  title = \"Literate Programming\",",
    "  year = {1984},",
    "}",
    "@book{lamport94,",
    "  title = {LaTeX: A Document Preparation System},",
    "}",
  ].join("\n")
  const buffer = new BufferModel({ name: "refs.bib", text, mode: "bibtex-mode" })
  const spans = bibtexFontLock(buffer)

  expectSpan(text, spans, "% bibliography", "comment")
  expectSpan(text, spans, "@article", "keyword")
  expectSpan(text, spans, "knuth84", "constant")
  expectSpan(text, spans, "author", "type")
  expectSpan(text, spans, "{Donald E. Knuth}", "string")
  expectSpan(text, spans, "\"Literate Programming\"", "string")
  expectSpan(text, spans, "year", "type")
  expectSpan(text, spans, "{1984}", "string")
  expectSpan(text, spans, "@book", "keyword")
  expectSpan(text, spans, "lamport94", "constant")
})

test("bibtex-mode imenu indexes entry keys", () => {
  const text = [
    "% @article{ignored,",
    "@article{knuth84,",
    "  title = \"Literate Programming\",",
    "}",
    "@book{lamport94,",
    "  title = {LaTeX},",
    "}",
  ].join("\n")
  const buffer = new BufferModel({ name: "refs.bib", text, mode: "bibtex-mode" })

  expect(bibtexImenuIndex(buffer)).toEqual([
    { name: "knuth84", point: text.indexOf("knuth84") },
    { name: "lamport94", point: text.indexOf("lamport94") },
  ])
})
