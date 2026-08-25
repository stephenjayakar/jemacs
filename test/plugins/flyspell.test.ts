import { afterEach, describe, expect, test } from "bun:test"
import { makeEditor } from "./helper"
import { spans } from "../harness"
import {
  FLYSPELL_INCORRECT_FACE,
  flyspellCheckBuffer,
  flyspellMisspellings,
  install,
  setSpellBackend,
  type SpellBackend,
} from "../../plugins/flyspell"
import { resetCustom, setCustom } from "../../src/runtime/custom"

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function fakeBackend(words: Record<string, string[]>): SpellBackend {
  return {
    name: "fake",
    check(text: string) {
      const misspelled = new Set(Object.keys(words).map(word => word.toLowerCase()))
      return [...text.matchAll(/[A-Za-z]+(?:'[A-Za-z]+)*/g)]
        .filter(match => misspelled.has(match[0].toLowerCase()))
        .map(match => ({ word: match[0], start: match.index, end: match.index + match[0].length }))
    },
    suggest(word: string) {
      return words[word.toLowerCase()] ?? []
    },
  }
}

afterEach(() => {
  setSpellBackend(undefined)
  resetCustom("flyspell-idle-delay")
})

describe("flyspell-mode", () => {
  test("debounced checking stores overlay spans for misspellings", async () => {
    setSpellBackend(fakeBackend({ teh: ["the"] }))
    const editor = makeEditor()
    install(editor)
    setCustom("flyspell-idle-delay", 0.01)
    const buffer = editor.scratch("*flyspell*", "teh cat teh\n", "text")

    await editor.run("flyspell-mode")
    await wait(30)

    expect(flyspellMisspellings(buffer).map(m => [m.start, m.end, m.word])).toEqual([
      [0, 3, "teh"],
      [8, 11, "teh"],
    ])
    expect(spans(editor)).toContainEqual({ start: 0, end: 3, face: FLYSPELL_INCORRECT_FACE })
    expect(spans(editor)).toContainEqual({ start: 8, end: 11, face: FLYSPELL_INCORRECT_FACE })
  })

  test("ispell-word replaces the word at point with the selected correction", async () => {
    setSpellBackend(fakeBackend({ teh: ["the", "ten"] }))
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*ispell-word*", "teh cat\n", "text")
    buffer.point = 1
    let collection: string[] | undefined
    editor.completingRead = async (_prompt, opts) => {
      collection = opts.collection
      return "the"
    }

    await editor.run("ispell-word")

    expect(collection).toEqual(["the", "ten"])
    expect(buffer.text).toBe("the cat\n")
    expect(flyspellMisspellings(buffer)).toEqual([])
  })

  test("empty correction accepts the word for the session and suppresses overlays", async () => {
    setSpellBackend(fakeBackend({ teh: ["the"] }))
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*flyspell-accept*", "teh cat teh\n", "text")
    buffer.point = 1
    await editor.run("flyspell-mode")
    await flyspellCheckBuffer(editor, buffer, { force: true })
    expect(flyspellMisspellings(buffer)).toHaveLength(2)

    editor.completingRead = async () => ""
    await editor.run("ispell-word")

    expect(buffer.text).toBe("teh cat teh\n")
    expect(flyspellMisspellings(buffer)).toEqual([])
    expect(spans(editor).some(span => span.face === FLYSPELL_INCORRECT_FACE)).toBe(false)
  })

  test("minor mode map binds word-before-point correction", async () => {
    setSpellBackend(fakeBackend({ teh: ["the"] }))
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*flyspell-key*", "teh\n", "text")
    buffer.point = 3
    editor.completingRead = async () => "the"

    await editor.run("flyspell-mode")
    await editor.handleKey({ name: "tab", meta: true })

    expect(buffer.text).toBe("the\n")
    expect(editor.keymap.get("M-$")).toBe("ispell-word")
  })

  test("commands report when no spell checker is available", async () => {
    setSpellBackend(null)
    const editor = makeEditor()
    install(editor)
    const messages: string[] = []
    editor.events.on("message", ({ text }) => { messages.push(text) })
    const buffer = editor.scratch("*flyspell-none*", "teh\n", "text")
    buffer.point = 1

    await editor.run("ispell-word")

    expect(messages.at(-1)).toBe("no spell checker found")
  })
})
