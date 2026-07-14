import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Editor } from "../../src/kernel/editor"
import { buildDisplayModel } from "../../src/display/build-display-model"
import { themedTextPlain } from "../../src/display/themed-text"
import { setCustom } from "../../src/runtime/custom"
import { install } from "../../plugins/jdap"

const temporaryPaths: string[] = []
afterAll(async () => {
  await Promise.all(temporaryPaths.map(path => rm(path, { recursive: true, force: true })))
})

function onlyPaneText(model: ReturnType<typeof buildDisplayModel>): string {
  if (model.windows.kind !== "leaf") throw new Error("Expected one window")
  return themedTextPlain(model.windows.pane.body)
}

describe("jdap-mode plugin", () => {
  test("registers commands and renders a persisted breakpoint in the shared gutter", async () => {
    const bootstrap = new Editor()
    install(bootstrap)
    const root = await mkdtemp(join(tmpdir(), "jemacs-jdap-"))
    temporaryPaths.push(root)
    setCustom("jdap-state-file", join(root, "state.json"))

    const source = join(root, "main.py")
    await writeFile(source, "first = 1\nsecond = 2\nprint(second)\n")
    const editor = new Editor()
    install(editor)
    const buffer = await editor.openFile(source)
    buffer.point = buffer.lineStarts[1]!
    await editor.run("jdap-toggle-breakpoint")

    expect(editor.commands.get("jdap-debug")).toBeDefined()
    expect(editor.commands.get("jdap-start-or-continue")).toBeDefined()
    expect(editor.keymaps.lookup("C-c d").status).toBe("pending")
    expect(editor.keymaps.lookup("C-c d u")).toMatchObject({ status: "matched", command: "jdap-toggle-ui" })
    expect(buffer.minorModes.has("jdap-mode")).toBe(true)
    expect(editor.gutterDecorations(buffer)).toMatchObject([{ line: 2, glyph: "●" }])

    const model = buildDisplayModel(editor, { viewport: { rows: 12, cols: 80 } })
    expect(onlyPaneText(model)).toContain("2 ●")
    expect(JSON.parse(await Bun.file(join(root, "state.json")).text()).projects[root].breakpoints).toHaveLength(1)
  })

  test("opens and restores its dedicated Run and Debug layout", async () => {
    const editor = new Editor()
    install(editor)
    const original = editor.currentWindowConfiguration()
    await editor.run("jdap-toggle-ui")
    expect([...editor.buffers.values()].some(buffer => buffer.name === "*Run and Debug*")).toBe(true)
    expect([...editor.buffers.values()].some(buffer => buffer.name === "*Debug Console*")).toBe(true)
    expect(editor.windowLayout.kind).toBe("split")
    await editor.run("jdap-toggle-ui")
    expect(editor.windowLayout).toEqual(original.layout)
  })
})
