import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"
import { listWindowLeaves } from "../src/kernel/window"
import { makeEditor } from "../test/plugins/helper"
const packagesDir = process.env.JEMACS_PACKAGES ?? join(homedir(), ".jemacs", "packages")
const { install } = await import(join(packagesDir, "file-sidebar/file-sidebar.ts"))
const {
  buildFileTree,
  defaultExpandedPaths,
  renderFileTree,
  sidebarFontLock,
  sidebarLineAtPoint,
} = await import(join(packagesDir, "file-sidebar/tree.ts"))

describe("file-sidebar tree", () => {
  test("buildFileTree groups paths into nested directories", () => {
    const tree = buildFileTree([
      "src/main.ts",
      "src/kernel/editor.ts",
      "README.md",
      "plugins/file-sidebar/index.ts",
    ])
    expect(tree.children.map(c => c.name)).toEqual(["plugins", "src", "README.md"])
    const src = tree.children.find(c => c.name === "src")!
    expect(src.isDirectory).toBe(true)
    expect(src.children.map(c => c.name)).toEqual(["kernel", "main.ts"])
  })

  test("renderFileTree respects expanded directories", () => {
    const tree = buildFileTree(["src/a.ts", "src/b.ts"])
    const src = tree.children[0]!
    const collapsed = renderFileTree(tree, new Set())
    expect(collapsed.text).toContain("▸ src/")
    expect(collapsed.text).not.toContain("a.ts")

    const expanded = renderFileTree(tree, new Set([src.relPath]))
    expect(expanded.text).toContain("▾ src/")
    expect(expanded.text).toContain("a.ts")
  })

  test("defaultExpandedPaths opens ancestors of the highlighted file", () => {
    const tree = buildFileTree(["src/kernel/editor.ts"])
    const expanded = defaultExpandedPaths(tree, "src/kernel/editor.ts")
    expect(expanded.has("src")).toBe(true)
    expect(expanded.has("src/kernel")).toBe(true)
  })

  test("sidebarLineAtPoint finds the line under point", () => {
    const tree = buildFileTree(["src/a.ts"])
    const rendered = renderFileTree(tree, defaultExpandedPaths(tree))
    const line = rendered.lines.find(l => l.relPath.endsWith("a.ts"))!
    expect(sidebarLineAtPoint(rendered.lines, line.lineStart)).toBe(line)
  })

  test("sidebarFontLock marks directories and the highlighted file", () => {
    const tree = buildFileTree(["src/a.ts"])
    const rendered = renderFileTree(tree, defaultExpandedPaths(tree, "src/a.ts"), { projectLabel: "proj" })
    const spans = sidebarFontLock(rendered.text, rendered.lines, { highlightRel: "src/a.ts", point: 0 })
    expect(spans.some(s => s.face === "directory")).toBe(true)
    expect(spans.some(s => s.face === "lazyHighlight")).toBe(true)
  })
})

describe("file-sidebar-mode", () => {
  test("toggle command enables and disables the global minor mode", async () => {
    const editor = makeEditor()
    await install(editor)
    expect(editor.isMinorModeEnabled("file-sidebar-mode")).toBe(false)
    await editor.run("file-sidebar-mode")
    expect(editor.isMinorModeEnabled("file-sidebar-mode")).toBe(true)
    await editor.run("file-sidebar-mode")
    expect(editor.isMinorModeEnabled("file-sidebar-mode")).toBe(false)
  })

  test("enabling mode creates a dedicated sidebar window", async () => {
    const editor = makeEditor()
    await install(editor)
    editor.scratch("main.ts", "hello", "text")
    await editor.run("file-sidebar-mode")
    for (let i = 0; i < 20; i++) {
      if (sidebarBuffer(editor)) break
      await new Promise(r => setTimeout(r, 10))
    }
    const sidebar = [...editor.buffers.values()].find(b => b.name === "*File Sidebar*")
    expect(sidebar).toBeDefined()
    expect(sidebar!.mode).toBe("file-sidebar-tree")
    const dedicated = listWindowLeaves(editor.windowLayout).filter(leaf => leaf.dedicated)
    expect(dedicated.length).toBeGreaterThan(0)
    await editor.run("file-sidebar-mode")
  })
})

function sidebarBuffer(editor: import("../src/kernel/editor").Editor) {
  return [...editor.buffers.values()].find(b => b.name === "*File Sidebar*")
}
