import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateSync } from "node:zlib"
import { buildDisplayModel } from "../../src/display/build-display-model"
import { FontMetricsTable } from "../../src/display/font-metrics"
import { themedTextPlain } from "../../src/display/themed-text"
import { findInlineImage, parseImageSize } from "../../plugins/markdown/inline-images"
import { resetFace } from "../../src/runtime/faces"
import { makeEditor } from "./helper"
import { install } from "../../plugins/markdown"

const dir = mkdtempSync(join(tmpdir(), "jemacs-img-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function png(width: number, height: number): Buffer {
  const crc = (buf: Buffer) => {
    let c = ~0
    for (const byte of buf) {
      c ^= byte
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
    return ~c >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc((width * 3 + 1) * height)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))])
}

mkdirSync(join(dir, "attachments"))
writeFileSync(join(dir, "attachments", "Pasted image 1.png"), png(800, 400))
const notePath = join(dir, "note.md")

class EmMetrics extends FontMetricsTable {
  override advance(ch: string, spec: Parameters<FontMetricsTable["advance"]>[1]): number { return ch === "\u200b" ? 0 : spec.px * 0.6 }
  override averageWidth(spec: Parameters<FontMetricsTable["averageWidth"]>[0]): number { return spec.px * 0.6 }
}
const gui = () => ({ unit: "pixels" as const, mouse: true, clipboard: true, osc52: false, perFaceFonts: true, fontMetrics: new EmMetrics() })

test("image headers give the pixel size", () => {
  expect(parseImageSize(png(800, 400))).toEqual({ width: 800, height: 400 })
  expect(parseImageSize(Buffer.from("not an image"))).toBeNull()
})

test("Obsidian embeds resolve through attachment folders; markdown links resolve relative to the file", () => {
  expect(findInlineImage("![[Pasted image 1.png]]", notePath)?.image).toMatchObject({ width: 800, height: 400 })
  expect(findInlineImage("![x](attachments/Pasted%20image%201.png)", notePath)?.image.src).toContain("Pasted%20image%201.png")
  expect(findInlineImage("![[missing.png]]", notePath)).toBeNull()
  expect(findInlineImage("![remote](https://example.com/a.png)", notePath)).toBeNull()
})

test("GUI text column draws an image under its line and task items as bare checkboxes", () => {
  resetFace("default")
  const editor = makeEditor()
  install(editor)
  const buffer = editor.scratch("note.md", "intro\n\n![[Pasted image 1.png]]\n\n- [ ] todo\n- [/] doing\n- plain\n", "markdown")
  ;(buffer as unknown as { _path: string })._path = notePath
  buffer.locals.set("markdown-hide-markup", true)
  const model = buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 80, cols: 120 }, hostCapabilities: gui() })
  const pane = model.windows.kind === "leaf" ? model.windows.pane : null
  const rows = themedTextPlain(pane!.body).split("\n")
  const imageRow = pane!.rowDecorations!.findIndex(d => d?.kind === "image")
  expect(rows[imageRow]).toBe("![[Pasted image 1.png]]")
  const image = pane!.rowDecorations![imageRow]!.image!
  expect(image.widthPx / image.heightPx).toBeCloseTo(2, 1)
  expect(image.widthPx).toBeLessThanOrEqual(pane!.textColumn!.widthPx)
  expect(rows).toContain("\u25a2 todo")
  expect(rows).toContain("\u2b1a doing")
  expect(rows).toContain("\u2981 plain")
})

test("an image embedded in a list item draws under the item", () => {
  resetFace("default")
  const editor = makeEditor()
  install(editor)
  const buffer = editor.scratch("note.md", "- [ ] John might like the doc. ![[Pasted image 1.png]]. <https://example.com>.\n", "markdown")
  ;(buffer as unknown as { _path: string })._path = notePath
  buffer.locals.set("markdown-hide-markup", true)
  const model = buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 80, cols: 120 }, hostCapabilities: gui() })
  const pane = model.windows.kind === "leaf" ? model.windows.pane : null
  const row = pane!.rowDecorations!.find(d => d?.image)
  expect(row?.kind).toBe("list-0")
  expect(row!.image!.src).toContain("Pasted%20image%201.png")
})
