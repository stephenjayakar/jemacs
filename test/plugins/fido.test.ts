import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeEditor } from "./helper"
import { install, flexScore, flexCompleter } from "../../plugins/fido"

describe("flex matching", () => {
  test("subsequence matches and non-matches", () => {
    expect(flexScore("abc", "alpha-bravo-charlie")).not.toBeNull()
    expect(flexScore("abc", "abc")).toBe(1)
    expect(flexScore("abc", "acb")).toBeNull()
    expect(flexScore("", "anything")).toBe(1)
    expect(flexScore("FF", "find-file")).not.toBeNull()
  })

  test("shorter candidates score higher (matchLen/candidateLen)", () => {
    const short = flexScore("ff", "ff")!
    const long = flexScore("ff", "find-file")!
    expect(short).toBeGreaterThan(long)
  })

  test("contiguous bonus: equal score ties break toward fewer match runs", () => {
    const out = flexCompleter("ab", ["axxxxb", "abxxxx"])
    expect(out).toEqual(["abxxxx", "axxxxb"])
  })

  test("flexCompleter sorts best-first and drops non-matches", () => {
    const out = flexCompleter("ff", ["alpha", "find-file", "ff", "diff-buffers"])
    expect(out[0]).toBe("ff")
    expect(out[1]).toBe("find-file")
    expect(out).toContain("diff-buffers")
    expect(out).not.toContain("alpha")
  })
})

describe("fido-vertical-mode minibuffer", () => {
  test("install enables the mode and sets editor.completer", () => {
    const editor = makeEditor()
    install(editor)
    expect(editor.globalMinorModes.has("fido-vertical-mode")).toBe(true)
    expect(editor.completer).toBe(flexCompleter)
  })

  test("vertical overlay renders flex-filtered candidates after the input", async () => {
    const editor = makeEditor()
    install(editor)
    const collection = ["find-file", "forward-char", "fill-paragraph", "list-buffers"]
    const result = editor.completingRead("M-x ", { collection })
    await editor.handleKey({ name: "f", sequence: "f" })
    await editor.handleKey({ name: "f", sequence: "f" })

    expect(editor.minibufferInput()).toBe("ff")
    const lines = editor.activeBuffer.text.split("\n")
    expect(lines[0]).toBe("ff")
    expect(lines[1]).toBe("► find-file")
    expect(editor.activeBuffer.text).not.toContain("forward-char")
    expect(editor.activeBuffer.point).toBeLessThanOrEqual(2)

    editor.minibufferCancel()
    await expect(result).resolves.toBeNull()
  })

  test("C-n / C-p move the selection marker", async () => {
    const editor = makeEditor()
    install(editor)
    const collection = ["apple", "apricot", "avocado"]
    const result = editor.completingRead("Pick: ", { collection })
    await editor.handleKey({ name: "a", sequence: "a" })
    let lines = editor.activeBuffer.text.split("\n")
    expect(lines[1]).toBe("► apple")

    await editor.handleKey({ name: "n", ctrl: true })
    lines = editor.activeBuffer.text.split("\n")
    expect(lines[1]).toBe("  apple")
    expect(lines[2]).toBe("► apricot")

    await editor.handleKey({ name: "p", ctrl: true })
    lines = editor.activeBuffer.text.split("\n")
    expect(lines[1]).toBe("► apple")

    editor.minibufferCancel()
    await expect(result).resolves.toBeNull()
  })

  test("RET accepts the selected candidate", async () => {
    const editor = makeEditor()
    install(editor)
    const collection = ["apple", "apricot", "avocado"]
    const result = editor.completingRead("Pick: ", { collection })
    await editor.handleKey({ name: "a", sequence: "a" })
    await editor.handleKey({ name: "n", ctrl: true })
    await editor.handleKey({ name: "return" })
    await expect(result).resolves.toBe("apricot")
    expect(editor.minibuffer).toBeNull()
  })

  test("RET with no candidates refuses; C-j submits the literal input", async () => {
    const editor = makeEditor()
    install(editor)
    const result = editor.completingRead("Pick: ", { collection: ["apple"] })
    await editor.handleKey({ name: "z", sequence: "z" })
    await editor.handleKey({ name: "z", sequence: "z" })
    expect(editor.activeBuffer.text).toContain("[No match]")
    await editor.handleKey({ name: "return" })
    expect(editor.minibuffer).not.toBeNull()
    await editor.handleKey({ name: "j", ctrl: true })
    await expect(result).resolves.toBe("zz")
  })

  test("M-j exits with literal input even when a candidate is selected", async () => {
    const editor = makeEditor()
    install(editor)
    const result = editor.completingRead("Pick: ", { collection: ["apple", "apricot"] })
    await editor.handleKey({ name: "a", sequence: "a" })
    await editor.handleKey({ name: "j", meta: true })
    await expect(result).resolves.toBe("a")
  })

  test("plain prompts without a collection get no overlay and submit literally", async () => {
    const editor = makeEditor()
    install(editor)
    const result = editor.completingRead("Name: ", {})
    await editor.handleKey({ name: "x", sequence: "x" })
    expect(editor.activeBuffer.text).toBe("x")
    await editor.handleKey({ name: "return" })
    await expect(result).resolves.toBe("x")
  })

  test("disabling the mode clears the completer delegate", () => {
    const editor = makeEditor()
    install(editor)
    editor.disableMinorMode("fido-vertical-mode")
    expect(editor.completer).toBeNull()
  })
})

describe("file completion", () => {
  test("RET on a directory descends; backspace at `/` goes up", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fido-"))
    await mkdir(join(dir, "sub"))
    await writeFile(join(dir, "sub", "leaf.txt"), "")
    await writeFile(join(dir, "top.txt"), "")

    const editor = makeEditor()
    install(editor)
    const result = editor.completingRead("Find file: ", {
      completion: "file",
      initialValue: dir + "/",
    })
    await editor.handleKey({ name: "s", sequence: "s" })
    expect(editor.activeBuffer.text).toContain("sub/")

    await editor.handleKey({ name: "return" })
    expect(editor.minibuffer).not.toBeNull()
    expect(editor.minibufferInput()).toBe(join(dir, "sub") + "/")
    expect(editor.activeBuffer.text).toContain("leaf.txt")

    await editor.handleKey({ name: "backspace" })
    expect(editor.minibufferInput()).toBe(dir + "/")

    await editor.handleKey({ name: "t", sequence: "t" })
    await editor.handleKey({ name: "return" })
    await expect(result).resolves.toBe(join(dir, "top.txt"))
  })
})

test("literal '/' inserts when the path tail is empty (tramp '//' restart)", async () => {
  const editor = makeEditor()
  install(editor)
  const result = editor.completingRead("Find file: ", { completion: "file", initialValue: "/tmp/" })
  await new Promise(r => setTimeout(r, 0))
  await editor.run("icomplete-fido-slash")
  // The minibuffer applies the '//' restart live, like Emacs C-x C-f.
  expect(editor.minibufferInput()).toBe("/")
  editor.minibufferCancel()
  await result
})

test("RET on a file prompt with no match submits the literal input", async () => {
  const editor = makeEditor()
  install(editor)
  const result = editor.completingRead("Find file: ", { completion: "file", initialValue: "/tmp/" })
  await new Promise(r => setTimeout(r, 0))
  for (const ch of "/ssh:box:/etc") await editor.run("self-insert-command", [ch])
  await editor.run("icomplete-fido-ret")
  // The leading '/' restarted the input, so the tramp path survives intact.
  expect(await result).toBe("/ssh:box:/etc")
})
