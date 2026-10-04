import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { install } from "../../plugins/markdown"
import { findInlineImage } from "../../plugins/markdown/inline-images"
import { markdownYankImage, pasteTimestamp } from "../../plugins/markdown/paste-image"
import { yankMedia } from "../../src/runtime/yank-media"
import { makeEditor } from "./helper"

const root = mkdtempSync(join(tmpdir(), "jemacs-paste-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

// A 1x1 PNG header is enough for the resolver to read a size.
const PNG = new Uint8Array("89504e470d0a1a0a0000000d4948445200000001000000010806000000".match(/../g)!.map(h => parseInt(h, 16)))
const NOW = new Date(2026, 9, 4, 14, 17, 28)
const NAME = "Pasted image 20261004141728.png"

let vaults = 0
function vault(app?: Record<string, unknown>): string {
  const dir = join(root, `vault-${vaults++}`)
  mkdirSync(join(dir, ".obsidian"), { recursive: true })
  if (app) writeFileSync(join(dir, ".obsidian", "app.json"), JSON.stringify(app))
  mkdirSync(join(dir, "Logs"), { recursive: true })
  writeFileSync(join(dir, "Logs", "Note.md"), "")
  return dir
}

async function open(path: string) {
  const editor = makeEditor()
  install(editor)
  const buffer = await editor.openFile(path)
  return { editor, buffer }
}

test("pasteTimestamp is Obsidian's YYYYMMDDHHmmss", () => {
  expect(pasteTimestamp(NOW)).toBe("20261004141728")
})

test("./attachments saves beside the note and embeds the bare name", async () => {
  const dir = vault({ attachmentFolderPath: "./attachments" })
  const { editor, buffer } = await open(join(dir, "Logs", "Note.md"))
  await markdownYankImage(editor, "image/png", PNG, NOW)
  expect(Uint8Array.from(readFileSync(join(dir, "Logs", "attachments", NAME)))).toEqual(PNG)
  expect(buffer.text).toBe(`![[${NAME}]]`)
  // The inline image display finds it again.
  expect(findInlineImage(buffer.text, buffer.path)?.image.src).toContain("Logs/attachments/Pasted%20image")
})

test("a taken name gets Obsidian's ` 1` suffix", async () => {
  const dir = vault({ attachmentFolderPath: "./attachments" })
  mkdirSync(join(dir, "Logs", "attachments"))
  writeFileSync(join(dir, "Logs", "attachments", NAME), "")
  const { editor, buffer } = await open(join(dir, "Logs", "Note.md"))
  await markdownYankImage(editor, "image/png", PNG, NOW)
  expect(buffer.text).toBe("![[Pasted image 20261004141728 1.png]]")
})

test("no app.json means the vault root, Obsidian's default", async () => {
  const dir = vault()
  const { editor } = await open(join(dir, "Logs", "Note.md"))
  await markdownYankImage(editor, "image/png", PNG, NOW)
  expect(existsSync(join(dir, NAME))).toBe(true)
})

test("a vault folder setting saves there; the display resolves it", async () => {
  const dir = vault({ attachmentFolderPath: "Assets/img" })
  const { editor, buffer } = await open(join(dir, "Logs", "Note.md"))
  await markdownYankImage(editor, "image/png", PNG, NOW)
  expect(existsSync(join(dir, "Assets", "img", NAME))).toBe(true)
  expect(findInlineImage(buffer.text, buffer.path)).not.toBeNull()
})

test("useMarkdownLinks with relative and absolute link formats", async () => {
  const rel = vault({ attachmentFolderPath: "Assets", useMarkdownLinks: true, newLinkFormat: "relative" })
  const a = await open(join(rel, "Logs", "Note.md"))
  await markdownYankImage(a.editor, "image/png", PNG, NOW)
  expect(a.buffer.text).toBe("![](../Assets/Pasted%20image%2020261004141728.png)")

  const abs = vault({ attachmentFolderPath: "Assets", newLinkFormat: "absolute" })
  const b = await open(join(abs, "Logs", "Note.md"))
  await markdownYankImage(b.editor, "image/png", PNG, NOW)
  expect(b.buffer.text).toBe(`![[Assets/${NAME}]]`)
  expect(findInlineImage(b.buffer.text, b.buffer.path)).not.toBeNull()
})

test("outside a vault it asks where to save", async () => {
  const dir = join(root, "plain")
  mkdirSync(dir)
  writeFileSync(join(dir, "README.md"), "")
  const { editor, buffer } = await open(join(dir, "README.md"))
  const pasting = markdownYankImage(editor, "image/png", PNG, NOW)
  await Promise.resolve()
  expect(editor.minibuffer?.prompt).toBe("Save image to: ")
  expect(editor.minibufferInput()).toBe(join(dir, "pasted-image-20261004141728.png"))
  editor.minibufferAccept(join(dir, "img", "shot.png"))
  await pasting
  expect(existsSync(join(dir, "img", "shot.png"))).toBe(true)
  expect(buffer.text).toBe("![](img/shot.png)")
})

test("yankMedia dispatches by mode lineage and refuses other modes", async () => {
  const dir = vault({ attachmentFolderPath: "./attachments" })
  const { editor, buffer } = await open(join(dir, "Logs", "Note.md"))
  buffer.mode = "gfm"
  expect(await yankMedia(editor, "image/png", PNG)).toBe(true)
  expect(buffer.text).toMatch(/^!\[\[Pasted image \d{14}\.png\]\]$/)

  const text = editor.scratch("notes.txt", "", "text")
  editor.switchToBuffer(text.id)
  expect(await yankMedia(editor, "image/png", PNG)).toBe(false)
  expect(text.text).toBe("")
})
