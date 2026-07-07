import { afterEach, expect, test } from "bun:test"
import { makeEditor } from "./helper"
import { getMode } from "../../src/modes/mode"
import {
  install,
  parseManApropos,
  setManBackend,
  stripManOverstrikes,
  type ManAproposBackend,
  type ManBackend,
} from "../../plugins/man"

let restoreBackend: (() => void) | null = null

afterEach(() => {
  restoreBackend?.()
  restoreBackend = null
})

function useBackend(page: ManBackend, apropos?: ManAproposBackend): void {
  restoreBackend?.()
  restoreBackend = setManBackend(page, apropos ?? null)
}

function bold(text: string): string {
  return [...text].map(ch => `${ch}\b${ch}`).join("")
}

function underline(text: string): string {
  return [...text].map(ch => `_\b${ch}`).join("")
}

function lineAtPointText(buffer: { lineBoundsAt(): { text: string } }): string {
  return buffer.lineBoundsAt().text
}

test("install registers man commands and man-mode bindings", () => {
  const editor = makeEditor()
  install(editor)

  expect(editor.commands.get("man")).toBeDefined()
  expect(editor.commands.get("woman")).toBeDefined()
  expect(editor.commands.get("man-mode")).toBeDefined()
  expect(editor.commands.get("man-next-section")).toBeDefined()
  expect(editor.commands.get("man-previous-section")).toBeDefined()
  expect(editor.commands.get("man-follow-reference")).toBeDefined()
  expect(editor.commands.get("man-revert")).toBeDefined()

  const mode = getMode("man-mode")
  expect(mode?.parent).toBe("text")
  expect(mode?.keymap?.get("q")).toBe("quit-window")
  expect(mode?.keymap?.get("n")).toBe("man-next-section")
  expect(mode?.keymap?.get("p")).toBe("man-previous-section")
  expect(mode?.keymap?.get("return")).toBe("man-follow-reference")
  expect(mode?.keymap?.get("g")).toBe("man-revert")
})

test("stripManOverstrikes strips backspaces and creates bold and underline spans", () => {
  const rendered = stripManOverstrikes(`NAME\n       ${bold("foo")} - ${underline("demo")} command\n`)

  expect(rendered.text).toBe("NAME\n       foo - demo command\n")
  expect(rendered.text).not.toContain("\b")
  expect(rendered.spans.some(span =>
    span.style?.bold && rendered.text.slice(span.start, span.end) === "foo",
  )).toBe(true)
  expect(rendered.spans.some(span =>
    span.style?.underline && span.style?.italic && rendered.text.slice(span.start, span.end) === "demo",
  )).toBe(true)
})

test("man renders overstrike-free text and exposes face spans through font-lock", async () => {
  let width = 0
  useBackend((_topic, options) => {
    width = options.width
    return `FOO(1)\n\nNAME\n       ${bold("foo")} - ${underline("demo")} command\n`
  })
  const editor = makeEditor()
  install(editor)
  editor.currentBuffer.locals.set("window-body-cols", 67)

  await editor.run("man", ["foo"])

  const buffer = editor.currentBuffer
  expect(width).toBe(67)
  expect(buffer.name).toBe("*Man foo*")
  expect(buffer.mode).toBe("man-mode")
  expect(buffer.readOnly).toBe(true)
  expect(buffer.text).toContain("foo - demo command")
  expect(buffer.text).not.toContain("\b")

  const spans = editor.fontLock(buffer)
  expect(spans.some(span => span.style?.bold && buffer.text.slice(span.start, span.end) === "foo")).toBe(true)
  expect(spans.some(span =>
    span.style?.underline && span.style?.italic && buffer.text.slice(span.start, span.end) === "demo",
  )).toBe(true)
})

test("n and p move between uppercase section headers", async () => {
  useBackend(() => "FOO(1)\n\nNAME\n       foo\nSYNOPSIS\n       foo [-x]\nDESCRIPTION\n       details\n")
  const editor = makeEditor()
  install(editor)
  await editor.run("man", ["foo"])

  await editor.handleKey({ name: "n", sequence: "n" })
  expect(lineAtPointText(editor.currentBuffer)).toBe("NAME")

  await editor.handleKey({ name: "n", sequence: "n" })
  expect(lineAtPointText(editor.currentBuffer)).toBe("SYNOPSIS")

  await editor.handleKey({ name: "p", sequence: "p" })
  expect(lineAtPointText(editor.currentBuffer)).toBe("NAME")
})

test("RET on a foo(1) reference opens that page through the backend", async () => {
  const calls: string[] = []
  useBackend(topic => {
    calls.push(topic)
    if (topic === "foo") return "FOO(1)\n\nSEE ALSO\n       bar(1)\n"
    if (topic === "bar(1)") return "BAR(1)\n\nNAME\n       bar page\n"
    return null
  })
  const editor = makeEditor()
  install(editor)
  await editor.run("man", ["foo"])

  const source = editor.currentBuffer
  source.point = source.text.indexOf("bar(1)") + 1
  const fed = editor.keymaps.feed({ name: "return" })
  expect(fed.status).toBe("matched")
  if (fed.status !== "matched") throw new Error("unreachable")
  expect(fed.command).toBe("man-follow-reference")
  await editor.run(fed.command)

  expect(calls).toEqual(["foo", "bar(1)"])
  expect(editor.currentBuffer.name).toBe("*Man bar(1)*")
  expect(editor.currentBuffer.text).toContain("bar page")
})

test("g rerenders the current man page", async () => {
  let renders = 0
  useBackend(topic => {
    renders++
    return `FOO(1)\n\nNAME\n       ${topic} render ${renders}\n`
  })
  const editor = makeEditor()
  install(editor)
  await editor.run("man", ["foo"])
  expect(editor.currentBuffer.text).toContain("render 1")

  await editor.handleKey({ name: "g", sequence: "g" })

  expect(renders).toBe(2)
  expect(editor.currentBuffer.text).toContain("render 2")
})

test("missing man pages message without replacing the current buffer", async () => {
  useBackend(() => null)
  const editor = makeEditor()
  install(editor)
  const before = editor.currentBuffer
  const messages: string[] = []
  editor.events.on("message", ({ text }) => { messages.push(text) })

  await editor.run("man", ["missing"])

  expect(editor.currentBuffer).toBe(before)
  expect(messages.at(-1)).toBe("No manual entry for missing")
})

test("man prompt uses fast apropos completion when available", async () => {
  const calls: string[] = []
  useBackend(topic => {
    calls.push(topic)
    return `BAR(1)\n\nNAME\n       ${topic}\n`
  }, () => "foo(1), fooctl(8) - foo tools\nbar (3) - bar library\n")
  const editor = makeEditor()
  install(editor)
  editor.completingRead = (prompt, options) => {
    expect(prompt).toBe("Manual entry: ")
    expect(options.collection).toEqual(["foo(1)", "fooctl(8)", "bar(3)"])
    return Promise.resolve("bar(3)")
  }

  await editor.run("man")

  expect(calls).toEqual(["bar(3)"])
  expect(editor.currentBuffer.name).toBe("*Man bar(3)*")
})

test("parseManApropos extracts candidates from comma-separated whatis lines", () => {
  expect(parseManApropos("foo(1), fooctl(8) - foo tools\nbar (3) - bar library\n")).toEqual([
    "foo(1)",
    "fooctl(8)",
    "bar(3)",
  ])
})
