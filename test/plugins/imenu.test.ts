import { describe, expect, test } from "bun:test"
import { makeEditor } from "./helper"
import { buildImenuIndex, install } from "../../plugins/imenu"

describe("imenu index", () => {
  test("python index finds classes and defs with positions", () => {
    const editor = makeEditor()
    const buffer = editor.scratch("*python-imenu*", [
      "def top():",
      "    pass",
      "",
      "class Widget:",
      "    def render(self):",
      "        pass",
      "",
      "async def later():",
      "    pass",
      "",
    ].join("\n"), "python")

    const index = buildImenuIndex(buffer)
    expect(index.map(entry => entry.name)).toEqual(["top", "Widget", "Widget.render", "later"])
    expect(index.find(entry => entry.name === "top")?.point).toBe(buffer.text.indexOf("def top"))
    expect(index.find(entry => entry.name === "Widget")?.point).toBe(buffer.text.indexOf("class Widget"))
    expect(index.find(entry => entry.name === "Widget.render")?.point).toBe(buffer.text.indexOf("    def render"))
    expect(index.find(entry => entry.name === "later")?.point).toBe(buffer.text.indexOf("async def later"))
  })

  test("typescript index finds functions, classes, and arrow consts", () => {
    const editor = makeEditor()
    const buffer = editor.scratch("*typescript-imenu*", [
      "export function load() {",
      "  return 1",
      "}",
      "",
      "class Store {",
      "  getValue(): number {",
      "    return 2",
      "  }",
      "}",
      "",
      "const save = async () => true",
      "",
    ].join("\n"), "typescript")

    const index = buildImenuIndex(buffer)
    expect(index.map(entry => entry.name)).toEqual(["load", "Store", "Store.getValue", "save"])
    expect(index.find(entry => entry.name === "load")?.point).toBe(buffer.text.indexOf("export function load"))
    expect(index.find(entry => entry.name === "Store")?.point).toBe(buffer.text.indexOf("class Store"))
    expect(index.find(entry => entry.name === "Store.getValue")?.point).toBe(buffer.text.indexOf("  getValue"))
    expect(index.find(entry => entry.name === "save")?.point).toBe(buffer.text.indexOf("const save"))
  })
})

describe("imenu command", () => {
  test("jump moves point to selected definition", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*imenu-jump*", [
      "function first() {",
      "}",
      "",
      "const target = () => 42",
      "",
    ].join("\n"), "typescript")
    buffer.point = 0
    editor.completingRead = (prompt, options) => {
      expect(prompt).toBe("Index item: ")
      expect(options.collection).toEqual(["first", "target"])
      return Promise.resolve("target")
    }

    await editor.run("imenu")

    expect(buffer.point).toBe(buffer.text.indexOf("const target"))
  })

  test("binds M-g i", () => {
    const editor = makeEditor()
    install(editor)
    expect(editor.keymap.get("M-g i")).toBe("imenu")
  })
})
