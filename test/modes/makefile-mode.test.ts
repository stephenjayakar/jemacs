import { expect, test } from "bun:test"
import { BufferModel } from "../../src/kernel/buffer"
import { getMode, modeFeature, type TextSpan } from "../../src/modes/mode"
import { installMakefileMode, makefileFontLock, makefileImenuIndex, makefileIndentLine } from "../../src/modes/makefile"

function expectSpan(text: string, spans: TextSpan[], needle: string, face: TextSpan["face"]): void {
  const start = text.indexOf(needle)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(spans).toContainEqual({ start, end: start + needle.length, face })
}

test("makefile-mode registers GNU makefile mode names", () => {
  installMakefileMode()

  expect(getMode("makefile-mode")?.parent).toBe("prog-mode")
  expect(getMode("makefile-mode")?.commentStart).toBe("#")
  expect(getMode("makefile-gmake-mode")?.parent).toBe("makefile-mode")
  expect(getMode("makefile-bsdmake-mode")?.parent).toBe("makefile-mode")
  expect(modeFeature("makefile-gmake-mode", "indentLine")).toBe(makefileIndentLine)
  expect(modeFeature("makefile-bsdmake-mode", "fontLock")).toBe(makefileFontLock)
})

test("makefile-mode font-lock highlights directives, assignments, targets, references, and comments", () => {
  installMakefileMode()
  const text = [
    "include config.mk",
    "ifeq ($(OS),Darwin)",
    "VAR := $(HOME)/bin",
    "all: main.o lib.o # build default",
    "\t$(CC) -o app main.o",
    "endif",
    "define TEMPLATE",
    "endef",
  ].join("\n")
  const buffer = new BufferModel({ name: "Makefile", text, mode: "makefile-mode" })
  const spans = makefileFontLock(buffer)

  expectSpan(text, spans, "include", "keyword")
  expectSpan(text, spans, "ifeq", "keyword")
  expectSpan(text, spans, "$(OS)", "builtin")
  expectSpan(text, spans, "VAR", "constant")
  expectSpan(text, spans, ":=", "keyword")
  expectSpan(text, spans, "$(HOME)", "builtin")
  expectSpan(text, spans, "all", "function")
  expectSpan(text, spans, "# build default", "comment")
  expectSpan(text, spans, "$(CC)", "builtin")
  expectSpan(text, spans, "endif", "keyword")
  expectSpan(text, spans, "define", "keyword")
  expectSpan(text, spans, "endef", "keyword")

  const ranged = makefileFontLock(buffer, { startLine: 2, endLine: 4, start: buffer.lineStarts[2]!, end: buffer.lineStarts[4]! })
  expect(ranged.some(span => text.slice(span.start, span.end) === "include")).toBe(false)
  expectSpan(text, ranged, "VAR", "constant")
  expectSpan(text, ranged, "all", "function")
})

test("makefile-mode imenu indexes top-level targets", () => {
  const text = [
    "VAR := nope",
    "all: main.o",
    "\tprintf 'not: target'",
    "install: all",
  ].join("\n")
  const buffer = new BufferModel({ name: "Makefile", text, mode: "makefile-mode" })

  expect(makefileImenuIndex(buffer)).toEqual([
    { name: "all", point: text.indexOf("all:") },
    { name: "install", point: text.indexOf("install:") },
  ])
})

test("makefile-mode indentation inserts a real tab for recipe lines", () => {
  const buffer = new BufferModel({ name: "Makefile", text: "all:\necho hi\n", mode: "makefile-mode" })
  buffer.point = buffer.text.indexOf("echo")

  makefileIndentLine(buffer)

  expect(buffer.text).toBe("all:\n\techo hi\n")
  expect(buffer.text).not.toContain("  echo hi")
})

test("makefile-mode indentation preserves recipe tabs and replaces spaces with a tab", () => {
  const alreadyTabbed = new BufferModel({ name: "Makefile", text: "all:\n\t$(CC) -o app\n", mode: "makefile-mode" })
  const before = alreadyTabbed.text
  alreadyTabbed.point = alreadyTabbed.text.indexOf("$(CC)")

  makefileIndentLine(alreadyTabbed)

  expect(alreadyTabbed.text).toBe(before)

  const spaced = new BufferModel({ name: "Makefile", text: "all:\n    echo hi\n", mode: "makefile-mode" })
  spaced.point = spaced.text.indexOf("echo")

  makefileIndentLine(spaced)

  expect(spaced.text).toBe("all:\n\techo hi\n")
})

test("makefile-mode indentation keeps top-level lines unindented", () => {
  const buffer = new BufferModel({ name: "Makefile", text: "  VAR = value\n", mode: "makefile-mode" })
  buffer.point = buffer.text.indexOf("VAR")

  makefileIndentLine(buffer)

  expect(buffer.text).toBe("VAR = value\n")
})
