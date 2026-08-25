import { describe, expect, test } from "bun:test"
import { Editor } from "../../src/kernel/editor"
import { BufferModel } from "../../src/kernel/buffer"
import { installDefaultModes } from "../../src/modes/default-modes"
import { install as installStephenMisc, cycleInflection, renumberProtoFields } from "../../plugins/stephen-misc"
import { elementRange, foldDisplay, foldedLines } from "../../plugins/stephen-misc/folding"
import { install as installSimple } from "../../lisp/simple"
import { getKillRing } from "../../src/runtime/kill-ring"

function makeEditor(): Editor {
  installDefaultModes()
  const editor = new Editor()
  installSimple(editor)
  installStephenMisc(editor)
  return editor
}

/** Replace the current buffer's contents and place point. */
function setBuffer(editor: Editor, text: string, point = 0): BufferModel {
  const buffer = editor.currentBuffer
  buffer.replaceRange(0, buffer.text.length, text)
  buffer.point = point
  buffer.mark = null
  buffer.markActive = false
  return buffer
}

/** Text of the *messages* buffer, where `editor.message` echoes land. */
function messagesText(editor: Editor): string {
  return [...editor.buffers.values()].find(b => b.name === "*messages*")?.text ?? ""
}

describe("cycleInflection", () => {
  test("cycles snake -> camel -> pascal -> upper -> snake", () => {
    expect(cycleInflection("foo_bar_baz")).toBe("fooBarBaz")
    expect(cycleInflection("fooBarBaz")).toBe("FooBarBaz")
    expect(cycleInflection("FooBarBaz")).toBe("FOO_BAR_BAZ")
    expect(cycleInflection("FOO_BAR_BAZ")).toBe("foo_bar_baz")
  })

  test("round-trips back to the original", () => {
    let word = "some_field_name"
    for (let i = 0; i < 4; i++) word = cycleInflection(word)
    expect(word).toBe("some_field_name")
  })

  test("single words still advance instead of sticking", () => {
    expect(cycleInflection("foo")).toBe("Foo")
    expect(cycleInflection("Foo")).toBe("FOO")
    expect(cycleInflection("FOO")).toBe("foo")
  })
})

describe("renumberProtoFields", () => {
  test("renumbers ascending from 1", () => {
    const input = [
      "  string name = 7;",
      "  int32 id = 22;",
      "  bool active = 3;",
    ].join("\n")
    expect(renumberProtoFields(input)).toBe([
      "  string name = 1;",
      "  int32 id = 2;",
      "  bool active = 3;",
    ].join("\n"))
  })

  test("tolerates varied spacing and leaves other numbers alone", () => {
    expect(renumberProtoFields("a =  9; // keep 42")).toBe("a = 1; // keep 42")
  })
})

describe("proto-renumber command", () => {
  test("requires a region", async () => {
    const editor = makeEditor()
    setBuffer(editor, "string a = 5;\n")
    await editor.run("proto-renumber")
    expect(messagesText(editor)).toContain("must select a region")
  })

  test("renumbers only the selected region", async () => {
    const editor = makeEditor()
    const text = "string a = 5;\nstring b = 9;\nstring c = 4;\n"
    const buffer = setBuffer(editor, text)
    buffer.mark = 0
    buffer.point = text.indexOf("string c")
    buffer.markActive = true
    await editor.run("proto-renumber")
    expect(buffer.text).toBe("string a = 1;\nstring b = 2;\nstring c = 4;\n")
  })
})

describe("string-inflection-cycle command", () => {
  test("rewrites the symbol at point and leaves point after it", async () => {
    const editor = makeEditor()
    const buffer = setBuffer(editor, "const my_field = 1", 8)
    await editor.run("string-inflection-cycle")
    expect(buffer.text).toBe("const myField = 1")
    expect(buffer.point).toBe("const myField".length)
  })

  test("reports when there is no symbol at point", async () => {
    const editor = makeEditor()
    setBuffer(editor, "   ", 1)
    await editor.run("string-inflection-cycle")
    expect(messagesText(editor)).toContain("No symbol at point")
  })
})

describe("slick-copy / slick-cut", () => {
  test("kill-ring-save with no region copies the whole line", async () => {
    const editor = makeEditor()
    const buffer = setBuffer(editor, "first line\nsecond line\n", 3)
    await editor.run("kill-ring-save")
    expect(getKillRing(editor)[0]).toBe("first line\n")
    expect(buffer.text).toBe("first line\nsecond line\n")
  })

  test("kill-region with no region kills the whole line", async () => {
    const editor = makeEditor()
    const buffer = setBuffer(editor, "first line\nsecond line\n", 3)
    await editor.run("kill-region")
    expect(buffer.text).toBe("second line\n")
    expect(getKillRing(editor)[0]).toBe("first line\n")
  })

  test("an active region still wins over the whole-line fallback", async () => {
    const editor = makeEditor()
    const buffer = setBuffer(editor, "hello world\n")
    buffer.mark = 0
    buffer.point = 5
    buffer.markActive = true
    await editor.run("kill-ring-save")
    expect(getKillRing(editor)[0]).toBe("hello")
  })
})

describe("delete-selection-mode", () => {
  test("typing replaces the active region", async () => {
    const editor = makeEditor()
    editor.enableMinorMode("delete-selection-mode")
    const buffer = setBuffer(editor, "hello world")
    buffer.mark = 0
    buffer.point = 5
    buffer.markActive = true
    await editor.run("self-insert-command", ["X"])
    expect(buffer.text).toBe("X world")
  })

  test("typing with no region inserts normally", async () => {
    const editor = makeEditor()
    editor.enableMinorMode("delete-selection-mode")
    const buffer = setBuffer(editor, "ab", 1)
    await editor.run("self-insert-command", ["X"])
    expect(buffer.text).toBe("aXb")
  })

  test("is off until enabled, matching Emacs defaults", async () => {
    const editor = makeEditor()
    const buffer = setBuffer(editor, "hello world")
    buffer.mark = 0
    buffer.point = 5
    buffer.markActive = true
    await editor.run("self-insert-command", ["X"])
    expect(buffer.text).toBe("helloX world")
  })
})

describe("buffer housekeeping", () => {
  test("my/kill-other-buffers keeps only the current buffer", async () => {
    const editor = makeEditor()
    const keep = editor.currentBuffer
    editor.scratch("*one*", "a", "text", false)
    editor.scratch("*two*", "b", "text", false)
    expect(editor.buffers.size).toBeGreaterThan(1)
    await editor.run("my/kill-other-buffers")
    expect([...editor.buffers.values()].map(b => b.id)).toEqual([keep.id])
  })

  test("my/close-tramp-buffers kills only remote/ssh buffers", async () => {
    const editor = makeEditor()
    const local = editor.currentBuffer
    const remote = new BufferModel({ name: "remote.py", path: "/ssh:host:/tmp/remote.py" })
    editor.addBuffer(remote)
    const sshNamed = editor.scratch("*ssh-session*", "", "text", false)
    const plain = editor.scratch("*notes*", "", "text", false)

    await editor.run("my/close-tramp-buffers")

    const ids = [...editor.buffers.values()].map(b => b.id)
    expect(ids).toContain(local.id)
    expect(ids).toContain(plain.id)
    expect(ids).not.toContain(remote.id)
    expect(ids).not.toContain(sshNamed.id)
  })
})

describe("yafolding", () => {
  const SOURCE = [
    "function outer() {",
    "  const a = 1",
    "  const b = 2",
    "}",
    "const after = 3",
  ].join("\n")

  test("elementRange spans the indented block", () => {
    expect(elementRange(SOURCE.split("\n"), 0)).toEqual([0, 2])
  })

  test("elementRange is null for a line with no deeper block", () => {
    expect(elementRange(SOURCE.split("\n"), 4)).toBeNull()
  })

  test("folding hides the block body and marks the header", () => {
    const fold = foldDisplay(SOURCE, new Set([0]))
    expect(fold).not.toBeNull()
    expect(fold!.text).toBe("function outer() { …\n}\nconst after = 3")
  })

  test("folding nothing returns null so the mode filter is untouched", () => {
    expect(foldDisplay(SOURCE, new Set())).toBeNull()
    expect(foldDisplay(SOURCE, new Set([4]))).toBeNull()
  })

  test("offset maps round-trip for visible text", () => {
    const fold = foldDisplay(SOURCE, new Set([0]))!
    const afterIndex = SOURCE.indexOf("const after")
    expect(fold.unmap(fold.map(afterIndex))).toBe(afterIndex)
  })

  test("toggling the fold command hides and restores lines", async () => {
    const editor = makeEditor()
    const buffer = setBuffer(editor, SOURCE, 0)
    await editor.run("yafolding-toggle-element")
    expect(foldedLines(buffer).has(0)).toBe(true)
    await editor.run("yafolding-toggle-element")
    expect(foldedLines(buffer).has(0)).toBe(false)
  })

  test("yafolding-show-all clears every fold", async () => {
    const editor = makeEditor()
    const buffer = setBuffer(editor, SOURCE, 0)
    await editor.run("yafolding-toggle-all")
    expect(foldedLines(buffer).size).toBeGreaterThan(0)
    await editor.run("yafolding-show-all")
    expect(foldedLines(buffer).size).toBe(0)
  })
})

describe("session commands", () => {
  test("restart-emacs and auto-save-visited-mode are registered", () => {
    const editor = makeEditor()
    expect(editor.commands.get("restart-emacs")).toBeDefined()
    expect(editor.commands.get("auto-save-visited-mode")).toBeDefined()
  })

  test("auto-save-visited-mode toggles the global minor mode", async () => {
    const editor = makeEditor()
    expect(editor.globalMinorModes.has("auto-save-visited-mode")).toBe(false)
    await editor.run("auto-save-visited-mode")
    expect(editor.globalMinorModes.has("auto-save-visited-mode")).toBe(true)
    await editor.run("auto-save-visited-mode")
    expect(editor.globalMinorModes.has("auto-save-visited-mode")).toBe(false)
  })
})
