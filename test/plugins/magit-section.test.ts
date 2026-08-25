import { expect, test } from "bun:test"
import { makeEditor } from "./helper"
import {
  MagitSectionBuilder,
  getSection,
  installMagitSection,
  magitSectionDisplayFilter,
  sectionEqual,
  sectionIdent,
  setRootSection,
  visibilityCache,
  type MagitSection,
} from "../../plugins/magit"

function sectionFixture() {
  const editor = makeEditor()
  installMagitSection(editor)
  const builder = new MagitSectionBuilder()
  let alpha!: MagitSection
  let beta!: MagitSection
  let alphaFile!: MagitSection
  builder.insertSection({ type: "group", value: "alpha" }, section => {
    alpha = section
    builder.insertHeading("Alpha")
    builder.insertSection({ type: "file", value: "a.txt" }, child => {
      alphaFile = child
      builder.insertHeading("modified   a.txt")
      builder.insert("body-a\n")
    })
    builder.insert("\n")
  })
  builder.insertSection({ type: "group", value: "beta" }, section => {
    beta = section
    builder.insertHeading("Beta")
    builder.insert("body-b\n")
  })
  const buffer = editor.scratch("*magit-section-test*", builder.toString(), "magit-section-mode")
  setRootSection(buffer, builder.root)
  return { editor, buffer, alpha, beta, alphaFile }
}

test("magit section builder records tree offsets", () => {
  const { buffer, alpha, beta, alphaFile } = sectionFixture()
  expect(buffer.text).toContain("Alpha\nmodified   a.txt\nbody-a\n")
  expect(alpha.start).toBe(0)
  expect(alpha.content).toBe("Alpha\n".length)
  expect(alphaFile.start).toBe(buffer.text.indexOf("modified   a.txt"))
  expect(alphaFile.content).toBe(buffer.text.indexOf("body-a"))
  expect(alpha.end).toBe(buffer.text.indexOf("Beta"))
  expect(beta.start).toBe(buffer.text.indexOf("Beta"))
})

test("magit section toggle folds via display filter without changing buffer text", async () => {
  const { editor, buffer, alpha } = sectionFixture()
  buffer.point = alpha.start
  await editor.run("magit-section-toggle")

  expect(alpha.hidden).toBe(true)
  expect(buffer.text).toContain("body-a")
  const filtered = magitSectionDisplayFilter(buffer)
  expect(filtered?.text).toContain("Alpha...")
  expect(filtered?.text).not.toContain("body-a")

  await editor.run("magit-section-toggle")
  expect(alpha.hidden).toBe(false)
  expect(magitSectionDisplayFilter(buffer)).toBeNull()
})

test("magit section show-level commands switch visible depth", async () => {
  const { editor, buffer } = sectionFixture()
  await editor.run("magit-section-show-level-1-all")
  let filtered = magitSectionDisplayFilter(buffer)
  expect(filtered?.text).toContain("Alpha...")
  expect(filtered?.text).toContain("Beta...")
  expect(filtered?.text).not.toContain("modified   a.txt")

  await editor.run("magit-section-show-level-4-all")
  filtered = magitSectionDisplayFilter(buffer)
  expect(filtered).toBeNull()
})

test("magit section navigation commands move by section tree", async () => {
  const { editor, buffer, alpha, beta, alphaFile } = sectionFixture()
  buffer.point = alpha.start

  await editor.run("magit-section-forward")
  expect(buffer.point).toBe(alphaFile.start)

  await editor.run("magit-section-up")
  expect(buffer.point).toBe(alpha.start)

  await editor.run("magit-section-forward-sibling")
  expect(buffer.point).toBe(beta.start)

  await editor.run("magit-section-backward")
  expect(buffer.point).toBe(alphaFile.start)
})

test("magit section visibility cache is reused by a later build", async () => {
  const { editor, buffer, alpha } = sectionFixture()
  buffer.point = alpha.start
  await editor.run("magit-section-toggle")
  const cache = visibilityCache(buffer)
  expect([...cache.values()]).toContain("hide")

  const builder = new MagitSectionBuilder({ visibilityCache: cache })
  let rebuilt!: MagitSection
  builder.insertSection({ type: "group", value: "alpha" }, section => {
    rebuilt = section
    builder.insertHeading("Alpha")
    builder.insert("body-a\n")
  })
  expect(rebuilt.hidden).toBe(true)
})

test("magit section ident, getSection and equality use lineage", () => {
  const { buffer, alphaFile } = sectionFixture()
  const ident = sectionIdent(alphaFile)
  expect(ident).toEqual([
    ["group", "alpha"],
    ["file", "a.txt"],
  ])
  const found = getSection(buffer, ident)
  expect(found).toBe(alphaFile)
  expect(sectionEqual(found, alphaFile)).toBe(true)
})

