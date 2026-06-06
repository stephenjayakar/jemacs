import { expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeEditor } from "../plugins/helper"
import { install, type ErrorLocation } from "../../plugins/next-error"

test("compile-goto-error maps buffer line to stored location, not array index", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jemacs-compile-goto-"))
  const fileA = join(dir, "a.txt")
  const fileB = join(dir, "b.txt")
  await writeFile(fileA, "alpha\nbeta\ngamma\n")
  await writeFile(fileB, "one\ntwo\nthree\n")

  const editor = makeEditor()
  install(editor)

  // *compilation* has a header before the first error line, so buffer-line ≠ locations index.
  // Error lines use a non-grep format so the GREP_LINE fallback can't paper over a bad lookup.
  const buf = editor.scratch(
    "*compilation*",
    `-*- mode: compilation; default-directory: ${JSON.stringify(dir)} -*-\n` +
      "Compilation started\n" +
      "\n" +
      "make -k\n" +
      `  --> ${fileA}:2:1\n` +
      `  --> ${fileB}:3:2\n`,
    "text",
  )
  buf.locals.set("default-directory", dir)
  const locA: ErrorLocation = { file: fileA, line: 2, col: 1, text: "" }
  const locB: ErrorLocation = { file: fileB, line: 3, col: 2, text: "" }
  buf.locals.set("next-error-locations", new Map<number, ErrorLocation>([[5, locA], [6, locB]]))

  buf.point = 0
  buf.moveLine(4) // line 5, the first error
  await editor.run("compile-goto-error")
  expect(editor.currentBuffer.path).toBe(fileA)
  expect(editor.currentBuffer.lineCol()).toEqual({ line: 2, col: 1 })
})
