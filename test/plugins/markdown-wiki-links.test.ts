import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeEditor } from "./helper"
import { install } from "../../plugins/markdown"
import { resolveWikiLink, wikiAnchorOffset, wikiLinks } from "../../plugins/markdown/wiki-links"

const root = mkdtempSync(join(tmpdir(), "jemacs-wiki-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function files(base: string, tree: Record<string, string>): string {
  for (const [rel, text] of Object.entries(tree)) {
    mkdirSync(join(base, rel, ".."), { recursive: true })
    writeFileSync(join(base, rel), text)
  }
  return base
}

const vault = files(join(root, "vault"), {
  ".obsidian/app.json": "{}",
  "2026-10-04.md": "# Today\n",
  "Places/wusong tiki boston.md": "# Wusong\n\n## Drinks\nmai tai ^tai\n",
  "Archive/Places/old bar.md": "old\n",
  "Archive/2026-10-04.md": "an archived copy\n",
  "PDFs/deck.pdf": "%PDF",
  "Places/index.md": "[[wusong tiki boston#Drinks|wusong]] [[2026-10-04]] [[deck.pdf#page=3]] ![[deck.pdf]]\n",
})

test("wikiLinks parses targets, anchors and aliases, and skips embeds", () => {
  const text = "[[a]] [[b#H|alias]] ![[img.png]] [[#Local]] [[ ]]"
  expect(wikiLinks(text).map(({ target, anchor, alias }) => ({ target, anchor, alias }))).toEqual([
    { target: "a", anchor: undefined, alias: undefined },
    { target: "b", anchor: "H", alias: "alias" },
    { target: "", anchor: "Local", alias: undefined },
  ])
})

test("vault links resolve by basename anywhere, preferring the linking note's folder then the shortest path", () => {
  const from = join(vault, "Places", "index.md")
  expect(resolveWikiLink("wusong tiki boston", from)).toEqual({ path: join(vault, "Places", "wusong tiki boston.md"), exists: true })
  expect(resolveWikiLink("2026-10-04", from)).toEqual({ path: join(vault, "2026-10-04.md"), exists: true })
  expect(resolveWikiLink("WUSONG TIKI BOSTON", join(vault, "x.md")).path).toBe(join(vault, "Places", "wusong tiki boston.md"))
  expect(resolveWikiLink("deck.pdf", from)).toEqual({ path: join(vault, "PDFs", "deck.pdf"), exists: true })
  expect(resolveWikiLink("Places/old bar", from)).toEqual({ path: join(vault, "Archive", "Places", "old bar.md"), exists: true })
})

test("an unresolved vault link names a new note at the vault root by default", () => {
  expect(resolveWikiLink("brand new", join(vault, "Places", "index.md"))).toEqual({ path: join(vault, "brand new.md"), exists: false })
  const current = files(join(root, "vault-current"), { ".obsidian/app.json": JSON.stringify({ newFileLocation: "current" }), "sub/a.md": "" })
  expect(resolveWikiLink("n", join(current, "sub", "a.md")).path).toBe(join(current, "sub", "n.md"))
})

test("outside a vault links are relative to the file, searching subdirectories only when asked", () => {
  const plain = files(join(root, "plain"), { "a.md": "", "deep/b.md": "" })
  expect(resolveWikiLink("b", join(plain, "a.md"), { vault: null })).toEqual({ path: join(plain, "b.md"), exists: false })
  expect(resolveWikiLink("b", join(plain, "a.md"), { vault: null, searchSubdirectories: true })).toEqual({ path: join(plain, "deep", "b.md"), exists: true })
})

test("wikiAnchorOffset finds headings case-insensitively and block ids", () => {
  const text = "# Wusong\n\n## Drinks\nmai tai ^tai\n"
  expect(wikiAnchorOffset(text, "drinks")).toBe(text.indexOf("## Drinks"))
  expect(wikiAnchorOffset(text, "Wusong#Drinks")).toBe(text.indexOf("## Drinks"))
  expect(wikiAnchorOffset(text, "^tai")).toBe(text.indexOf("mai tai"))
  expect(wikiAnchorOffset(text, "nope")).toBeNull()
})

test("wiki links are fontified as links", async () => {
  const editor = makeEditor()
  install(editor)
  const buffer = editor.scratch("n.md", "see [[page]] ok\n", "markdown")
  expect(editor.fontLock(buffer).some(span => String(span.face) === "markdown-link" && span.start === 4 && span.end === 12)).toBe(true)
})

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(5)
}

test("clicking a wiki link visits the note and its heading", async () => {
  const editor = makeEditor()
  install(editor)
  const index = await editor.openFile(join(vault, "Places", "index.md"))

  editor.clickWindow(editor.selectedWindowId, index.text.indexOf("wusong tiki") + 2)
  await until(() => editor.currentBuffer !== index)

  expect(editor.currentBuffer.path).toBe(join(vault, "Places", "wusong tiki boston.md"))
  expect(editor.currentBuffer.point).toBe(editor.currentBuffer.text.indexOf("## Drinks"))
})

test("markdown-follow-thing-at-point follows wiki links and hands attachments to the OS", async () => {
  const opened: string[] = []
  const editor = makeEditor()
  install(editor, { openExternal: target => { opened.push(target) } })
  const index = await editor.openFile(join(vault, "Places", "index.md"))

  index.point = index.text.indexOf("deck.pdf#page")
  await editor.run("markdown-follow-thing-at-point")
  expect(opened).toEqual([`file://${join(vault, "PDFs", "deck.pdf").split("/").map(encodeURIComponent).join("/")}`])
  expect(editor.currentBuffer).toBe(index)

  index.point = index.text.indexOf("[[2026") + 3
  await editor.run("markdown-follow-wiki-link-at-point")
  expect(editor.currentBuffer.path).toBe(join(vault, "2026-10-04.md"))
})
