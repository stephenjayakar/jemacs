/** Emacs `:extend`: a face's background fills the rest of the row after the text. */
import { describe, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { extendRowBackgrounds, rowExtendFills, styleToChunk } from "../../src/display/themed-text"

const window = new Window({ url: "http://localhost" })
const g = globalThis as Record<string, unknown>
g.window = window
g.document = window.document
g.HTMLElement = window.HTMLElement
const { renderBodyRows } = await import("../../src/display/dom-frame")

const tint = { bg: "#102010", extend: true }
const body = { chunks: [{ text: "plain\n" }, { text: "+add", ...tint }, { text: "\n", ...tint }, { text: "end" }] }

describe("face :extend", () => {
  test("styleToChunk keeps extend only with a background", () => {
    expect(styleToChunk({ bg: "#000", extend: true }).extend).toBe(true)
    expect(styleToChunk({ fg: "#fff", extend: true }).extend).toBeUndefined()
  })

  test("each row takes its fill from the face on its newline", () => {
    expect(rowExtendFills(body)).toEqual([undefined, "#102010", undefined])
  })

  test("a character grid pads the row with tinted spaces", () => {
    const out = extendRowBackgrounds(body, 10)
    const pad = out.chunks.find(c => c.text === "      ")
    expect(pad?.bg).toBe("#102010")
    expect(out.chunks.map(c => c.text).join("")).toBe("plain\n+add      \nend")
  })

  test("a DOM host paints the row element", () => {
    const el = window.document.createElement("div") as unknown as HTMLElement
    const rows = renderBodyRows(el, body as never)
    expect(rows[0]!.style.backgroundColor).toBe("")
    expect(rows[1]!.style.backgroundColor).not.toBe("")
    expect(rows[2]!.style.backgroundColor).toBe("")
  })
})
