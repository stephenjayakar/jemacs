import { expect, test, beforeAll } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeEditor } from "./helper"
import { addHook } from "../../src/kernel/hooks"
import {
  install,
  parseGrepOutput,
  setLocationList,
  locationList,
  locationIndex,
  type ErrorLocation,
} from "../../plugins/next-error"

let dir: string
let fileA: string
let fileB: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "jemacs-next-error-"))
  fileA = join(dir, "a.txt")
  fileB = join(dir, "b.txt")
  await writeFile(fileA, "alpha\nbeta\ngamma\ndelta\n")
  await writeFile(fileB, "one two\nthree four\nfive six\n")
})

function fixtureLocations(): ErrorLocation[] {
  return [
    { file: fileA, line: 2, col: 1, text: "beta" },
    { file: fileA, line: 4, col: 3, text: "delta" },
    { file: fileB, line: 2, col: 7, text: "three four" },
  ]
}

test("parseGrepOutput parses rg --line-number --column --no-heading", () => {
  const text = [
    "src/foo.ts:12:5:const foo = 1",
    "lib/bar.ts:3:1:export bar",
    "",
    "noise without colons",
  ].join("\n")
  const locs = parseGrepOutput(text)
  expect(locs).toEqual([
    { file: "src/foo.ts", line: 12, col: 5, text: "const foo = 1" },
    { file: "lib/bar.ts", line: 3, col: 1, text: "export bar" },
  ])
})

test("install registers commands and M-g n / M-g p bindings", () => {
  const editor = makeEditor()
  install(editor)
  expect(editor.commands.get("next-error")).toBeDefined()
  expect(editor.commands.get("previous-error")).toBeDefined()
  expect(editor.commands.get("first-error")).toBeDefined()
  expect(editor.commands.get("compile-goto-error")).toBeDefined()
  expect(editor.keymap.get("M-g n")).toBe("next-error")
  expect(editor.keymap.get("M-g M-n")).toBe("next-error")
  expect(editor.keymap.get("M-g p")).toBe("previous-error")
  expect(editor.keymap.get("M-g M-p")).toBe("previous-error")
  expect(editor.keymap.get("C-x `")).toBe("next-error")
})

test("next-error walks the location list and opens files at line:col", async () => {
  const editor = makeEditor()
  install(editor)
  setLocationList(editor, fixtureLocations())
  expect(locationIndex(editor)).toBe(-1)

  await editor.run("next-error")
  expect(locationIndex(editor)).toBe(0)
  expect(editor.currentBuffer.path).toBe(fileA)
  expect(editor.currentBuffer.lineCol()).toEqual({ line: 2, col: 1 })

  await editor.run("next-error")
  expect(locationIndex(editor)).toBe(1)
  expect(editor.currentBuffer.path).toBe(fileA)
  expect(editor.currentBuffer.lineCol()).toEqual({ line: 4, col: 3 })

  await editor.run("next-error")
  expect(locationIndex(editor)).toBe(2)
  expect(editor.currentBuffer.path).toBe(fileB)
  expect(editor.currentBuffer.lineCol()).toEqual({ line: 2, col: 7 })
})

test("next-error past end and previous-error before start clamp with a message", async () => {
  const editor = makeEditor()
  install(editor)
  setLocationList(editor, fixtureLocations())

  let lastMessage = ""
  editor.events.on("message", ({ text }) => { lastMessage = text })

  await editor.run("next-error")
  await editor.run("next-error")
  await editor.run("next-error")
  expect(locationIndex(editor)).toBe(2)

  await editor.run("next-error")
  expect(locationIndex(editor)).toBe(2)
  expect(lastMessage).toContain("No more errors")

  await editor.run("previous-error")
  expect(locationIndex(editor)).toBe(1)
  expect(editor.currentBuffer.path).toBe(fileA)
  expect(editor.currentBuffer.lineCol()).toEqual({ line: 4, col: 3 })

  await editor.run("previous-error")
  await editor.run("previous-error")
  expect(locationIndex(editor)).toBe(0)
  expect(lastMessage).toContain("No previous error")
})

test("next-error with empty list messages and does nothing", async () => {
  const editor = makeEditor()
  install(editor)
  let lastMessage = ""
  editor.events.on("message", ({ text }) => { lastMessage = text })
  const before = editor.currentBuffer
  await editor.run("next-error")
  expect(lastMessage).toContain("No buffers contain error message locations")
  expect(editor.currentBuffer).toBe(before)
})

test("first-error resets to the head", async () => {
  const editor = makeEditor()
  install(editor)
  setLocationList(editor, fixtureLocations())
  await editor.run("next-error")
  await editor.run("next-error")
  expect(locationIndex(editor)).toBe(1)
  await editor.run("first-error")
  expect(locationIndex(editor)).toBe(0)
  expect(editor.currentBuffer.lineCol()).toEqual({ line: 2, col: 1 })
})

test("RET in *grep* runs compile-goto-error and syncs the location index", async () => {
  const editor = makeEditor()
  install(editor)
  const locs = fixtureLocations()
  setLocationList(editor, locs)
  const grepText = locs.map(l => `${l.file}:${l.line}:${l.col}:${l.text}`).join("\n") + "\n"
  const grep = editor.scratch("*grep*", grepText, "grep")
  grep.kind = "grep"

  expect(grep.mode).toBe("grep")
  grep.point = 0
  grep.moveLine(2)

  const fed = editor.keymaps.feed({ name: "return" })
  expect(fed.status).toBe("matched")
  if (fed.status !== "matched") throw new Error("unreachable")
  expect(fed.command).toBe("compile-goto-error")
  await editor.run(fed.command)

  expect(editor.currentBuffer.path).toBe(fileB)
  expect(editor.currentBuffer.lineCol()).toEqual({ line: 2, col: 7 })
  expect(locationIndex(editor)).toBe(2)

  await editor.run("previous-error")
  expect(locationIndex(editor)).toBe(1)
  expect(editor.currentBuffer.path).toBe(fileA)
})

test("counsel-ag is redefined to populate the location list", async () => {
  const editor = makeEditor()
  install(editor)
  const spec = editor.commands.get("counsel-ag")
  expect(spec).toBeDefined()
  expect(spec!.description).toContain("location list")

  const fakeOutput = `${fileA}:1:1:alpha\n${fileB}:3:6:five six\n`
  setLocationList(editor, parseGrepOutput(fakeOutput))
  expect(locationList(editor).length).toBe(2)

  const buf = editor.scratch("*grep*", fakeOutput, "grep")
  buf.kind = "grep"
  expect(buf.mode).toBe("grep")

  await editor.run("next-error")
  expect(editor.currentBuffer.path).toBe(fileA)
  expect(editor.currentBuffer.lineCol()).toEqual({ line: 1, col: 1 })
})

test("next-error-hook fires after visiting a location", async () => {
  const editor = makeEditor()
  install(editor)
  setLocationList(editor, fixtureLocations())
  const seen: string[] = []
  addHook("next-error-hook", ({ buffer }) => { seen.push(buffer.path ?? "") })
  await editor.run("next-error")
  await editor.run("next-error")
  expect(seen).toEqual([fileA, fileA])
})
