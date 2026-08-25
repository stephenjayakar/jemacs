import { describe, expect, test } from "bun:test"
import { makeEditor } from "./helper"
import { install, renderTabulatedList, TABULATED_LIST_REVERT_LOCAL } from "../../plugins/tabulated-list"

describe("tabulated-list-mode", () => {
  test("renders aligned columns and sorts the column at point", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*tabulated-list-test*", "", "tabulated-list-mode")

    renderTabulatedList(buffer, {
      columns: [
        { name: "Name", width: 8, sortable: true },
        { name: "Size", width: 4, sortable: true, align: "right" },
      ],
      entries: [
        { id: "beta", cells: ["beta", 10] },
        { id: "alpha", cells: ["alpha", 2] },
      ],
    })

    let lines = buffer.text.split("\n")
    expect(lines[0]!.slice(0, 8)).toBe("Name    ")
    expect(lines[0]!.slice(9, 13)).toBe("Size")
    expect(lines[1]!.slice(0, 8)).toBe("beta    ")
    expect(lines[1]!.slice(9, 13)).toBe("  10")

    buffer.point = buffer.text.indexOf("Size")
    await editor.run("tabulated-list-sort")

    lines = buffer.text.split("\n")
    expect(lines[0]).toContain("Size")
    expect(lines[0]).toContain("▲")
    expect(lines[1]!.slice(0, 8).trim()).toBe("alpha")
    expect(lines[2]!.slice(0, 8).trim()).toBe("beta")

    await editor.run("tabulated-list-sort")

    lines = buffer.text.split("\n")
    expect(lines[0]).toContain("▼")
    expect(lines[1]!.slice(0, 8).trim()).toBe("beta")
    expect(lines[2]!.slice(0, 8).trim()).toBe("alpha")
  })

  test("g dispatches the buffer-local refresh callback", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("*tabulated-refresh*", "", "tabulated-list-mode")
    let refreshed = false

    renderTabulatedList(buffer, {
      columns: [{ name: "Name", width: 6 }],
      entries: [{ id: "old", cells: ["old"] }],
    })
    buffer.locals.set(TABULATED_LIST_REVERT_LOCAL, () => {
      refreshed = true
      renderTabulatedList(buffer, {
        columns: [{ name: "Name", width: 6 }],
        entries: [{ id: "new", cells: ["new"] }],
      })
    })

    await editor.handleKey({ name: "g", sequence: "g" })

    expect(refreshed).toBe(true)
    expect(buffer.text).toContain("new")
    expect(buffer.text).not.toContain("old")
  })
})
