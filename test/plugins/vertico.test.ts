import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeEditor } from "./helper"
import { install } from "../../plugins/vertico"
import { resetCustom, setCustom } from "../../src/runtime/custom"

/** Editor with vertico-mode enabled and a collection prompt open + refreshed.
 *  `customs` are applied after install (defcustom would otherwise overwrite them). */
async function open(collection: string[], customs: Record<string, unknown> = {}) {
  const editor = makeEditor()
  install(editor)
  for (const [k, v] of Object.entries(customs)) setCustom(k, v)
  editor.enableMinorMode("vertico-mode")
  const result = editor.prompt("Pick: ", "", undefined, { collection })
  await editor.refreshMinibufferCompletions()
  return { editor, result }
}

const display = (editor: ReturnType<typeof makeEditor>) => editor.minibufferCompletionDisplay?.text ?? ""

afterEach(() => {
  // custom vars are process-global; restore defaults so later test files see baselines
  for (const name of ["vertico-cycle", "vertico-count", "vertico-scroll-margin"]) resetCustom(name)
})

describe("vertico-cycle wraparound", () => {
  test("cycle=true: vertico-next from last wraps to prompt (-1) then to 0", async () => {
    const { editor, result } = await open(["aa", "bb", "cc"], { "vertico-cycle": true })
    // index 0 → 1 → 2
    await editor.run("vertico-next")
    await editor.run("vertico-next")
    expect(display(editor)).toContain("3/3")
    expect(display(editor)).toContain("> cc")
    // 2 → -1 (prompt slot)
    await editor.run("vertico-next")
    expect(display(editor)).toContain("*/3")
    expect(display(editor)).not.toContain("> ")
    // -1 → 0
    await editor.run("vertico-next")
    expect(display(editor)).toContain("1/3")
    expect(display(editor)).toContain("> aa")
    editor.minibufferCancel()
    await result
  })

  test("cycle=true: vertico-previous from 0 wraps to prompt then to last", async () => {
    const { editor, result } = await open(["aa", "bb", "cc"], { "vertico-cycle": true })
    expect(display(editor)).toContain("1/3")
    await editor.run("vertico-previous")
    expect(display(editor)).toContain("*/3")
    await editor.run("vertico-previous")
    expect(display(editor)).toContain("3/3")
    editor.minibufferCancel()
    await result
  })

  test("cycle=false (default): vertico-next clamps at last", async () => {
    const { editor, result } = await open(["aa", "bb", "cc"])
    await editor.run("vertico-next")
    await editor.run("vertico-next")
    await editor.run("vertico-next")
    await editor.run("vertico-next")
    expect(display(editor)).toContain("3/3")
    editor.minibufferCancel()
    await result
  })
})

describe("vertico-first / vertico-last", () => {
  test("jump to ends of the candidate list", async () => {
    const { editor, result } = await open(["aa", "bb", "cc", "dd"])
    await editor.run("vertico-last")
    expect(display(editor)).toContain("4/4")
    expect(display(editor)).toContain("> dd")
    await editor.run("vertico-first")
    expect(display(editor)).toContain("1/4")
    expect(display(editor)).toContain("> aa")
    editor.minibufferCancel()
    await result
  })
})

describe("computeScroll margin clamping", () => {
  test("count=5 margin=2, 20 candidates: goto 17 scrolls window to [15,20)", async () => {
    const candidates = Array.from({ length: 20 }, (_, i) => `c${String(i).padStart(2, "0")}`)
    const { editor, result } = await open(candidates, { "vertico-count": 5, "vertico-scroll-margin": 2 })
    for (let i = 0; i < 17; i++) await editor.run("vertico-next")
    const text = display(editor)
    expect(text).toContain("18/20")
    expect(text).toContain("> c17")
    expect(text).toContain("c15")
    expect(text).toContain("c19")
    expect(text).not.toContain("c14")
    // selectedLine: count header + (index − scroll) = 1 + (17 − 15)
    expect(editor.minibufferCompletionDisplay?.selectedLine).toBe(3)
    editor.minibufferCancel()
    await result
  })

  test("vertico-scroll-up moves by vertico-count", async () => {
    const candidates = Array.from({ length: 20 }, (_, i) => `c${String(i).padStart(2, "0")}`)
    const { editor, result } = await open(candidates, { "vertico-count": 5 })
    await editor.run("vertico-scroll-up")
    expect(display(editor)).toContain("6/20")
    await editor.run("vertico-scroll-down")
    expect(display(editor)).toContain("1/20")
    editor.minibufferCancel()
    await result
  })
})

describe("vertico-next-group / vertico-previous-group", () => {
  // candidateGroup() only differentiates by parent dir, and fileCompletionCandidates
  // lists one directory — so all reachable states have a single group. The walk loop
  // therefore exercises its boundary clamp: forward to last, backward to first.
  test("file completion (single group): next-group clamps to last, previous-group to first", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vertico-group-"))
    await writeFile(join(dir, "a.txt"), "")
    await writeFile(join(dir, "b.txt"), "")
    await writeFile(join(dir, "c.txt"), "")

    const editor = makeEditor()
    install(editor)
    editor.enableMinorMode("vertico-mode")
    const result = editor.prompt("Find: ", `${dir}/`, undefined, { completion: "file" })
    await editor.refreshMinibufferCompletions()
    // preselect=directory + trailing "/" → index starts at -1; next-group walks from max(0,-1)=0
    expect(display(editor)).toContain("*/3")

    await editor.run("vertico-next-group")
    expect(display(editor)).toContain("3/3")

    await editor.run("vertico-previous-group")
    expect(display(editor)).toContain("1/3")

    editor.minibufferCancel()
    await result
  })

  test("non-file collection: groups are all empty, next-group jumps to last", async () => {
    const { editor, result } = await open(["aa", "bb", "cc", "dd", "ee"])
    expect(display(editor)).toContain("1/5")
    await editor.run("vertico-next-group")
    expect(display(editor)).toContain("5/5")
    editor.minibufferCancel()
    await result
  })
})

describe("vertico-exit-input", () => {
  test("M-RET returns the raw input, not the highlighted candidate", async () => {
    const { editor, result } = await open(["alpha", "alphabet"])
    await editor.handleKey({ name: "a", sequence: "a" })
    await editor.handleKey({ name: "l", sequence: "l" })
    expect(display(editor)).toContain("> alpha")
    await editor.run("vertico-exit-input")
    await expect(result).resolves.toBe("al")
  })

  test("vertico-exit returns the highlighted candidate (contrast with exit-input)", async () => {
    const { editor, result } = await open(["alpha", "alphabet"])
    await editor.handleKey({ name: "a", sequence: "a" })
    await editor.handleKey({ name: "l", sequence: "l" })
    await editor.run("vertico-exit")
    await expect(result).resolves.toBe("alpha")
  })
})

describe("vertico-save", () => {
  test("populates *Vertico Completions* with current candidates", async () => {
    const { editor, result } = await open(["alpha", "gamma", "delta"])
    await editor.run("vertico-save")
    const buf = [...editor.buffers.values()].find(b => b.name === "*Vertico Completions*")
    expect(buf).toBeDefined()
    // candidates are sorted length-then-alpha → all len 5: alpha, delta, gamma
    expect(buf?.text).toBe("alpha\ndelta\ngamma")
    editor.minibufferCancel()
    await result
  })

  test("overwrites existing *Vertico Completions* buffer", async () => {
    const { editor, result } = await open(["one", "two"])
    await editor.run("vertico-save")
    editor.minibufferCancel()
    await result

    const result2 = editor.prompt("Pick: ", "", undefined, { collection: ["xx"] })
    await editor.refreshMinibufferCompletions()
    await editor.run("vertico-save")
    const buf = [...editor.buffers.values()].find(b => b.name === "*Vertico Completions*")
    expect(buf?.text).toBe("xx")
    editor.minibufferCancel()
    await result2
  })
})
