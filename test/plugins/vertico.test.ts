import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeEditor } from "./helper"
import { display as displayModel } from "../harness/display"
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
  for (const name of ["vertico-cycle", "vertico-count", "vertico-scroll-margin", "vertico-dynamic-debounce"]) resetCustom(name)
})

describe("dynamic collections", () => {
  const DEBOUNCE = 10

  /** Let the debounce timer fire and the query it starts finish painting. */
  const settle = (ms = DEBOUNCE * 6) => new Promise(resolve => setTimeout(resolve, ms))

  function openDynamic(source: (input: string, signal: AbortSignal) => Promise<string[]>) {
    const editor = makeEditor()
    install(editor)
    setCustom("vertico-dynamic-debounce", DEBOUNCE)
    editor.enableMinorMode("vertico-mode")
    const result = editor.prompt("Find: ", "", undefined, { dynamicCollection: source })
    return { editor, result }
  }

  test("candidates come from the source, in the order the source returned them", async () => {
    // Deliberately not sorted: a remote source ranks its own results and vertico must not resort.
    const { editor, result } = openDynamic(async input => [`${input}-zzz`, `${input}-a`, `${input}-mm`])
    await editor.handleKey({ name: "q", sequence: "q" })
    await settle()
    const lines = display(editor).split("\n")
    expect(lines[0]).toContain("1/3")
    expect(lines.slice(1)).toEqual(["> q-zzz", "  q-a", "  q-mm"])
    editor.minibufferCancel()
    await result
  })

  test("candidates are not re-filtered against the input", async () => {
    // A code-search backend matches on path components the typed string never
    // appears in verbatim.
    const { editor, result } = openDynamic(async () => ["java/com/example/Widget.java"])
    await editor.handleKey({ name: "w", sequence: "w" })
    await settle()
    expect(display(editor)).toContain("> java/com/example/Widget.java")
    editor.minibufferCancel()
    await result
  })

  test("typing does not wait for the query", async () => {
    // verticoRefresh runs from post-command-hook, which the key loop awaits: awaiting a slow
    // remote source there would stall every keystroke behind it.
    const { editor, result } = openDynamic(async () => {
      await new Promise(resolve => setTimeout(resolve, 500))
      return ["slow"]
    })
    const start = Date.now()
    for (const key of ["a", "b", "c"]) await editor.handleKey({ name: key, sequence: key })
    expect(Date.now() - start).toBeLessThan(250)
    expect(editor.minibufferInput()).toBe("abc")
    editor.minibufferCancel()
    await result
  })

  test("a superseded query is aborted and never paints its candidates", async () => {
    const started: string[] = []
    const release: Array<() => void> = []
    const { editor, result } = openDynamic(async (input, signal) => {
      started.push(input)
      if (input !== "a") return ["fresh"]
      // Hold the first query open until the second one has been issued.
      await new Promise<void>(resolve => release.push(resolve))
      if (signal.aborted) throw new Error("aborted")
      return ["stale"]
    })

    await editor.handleKey({ name: "a", sequence: "a" })
    await settle()
    expect(started).toEqual(["a"])
    await editor.handleKey({ name: "b", sequence: "b" })
    await settle()
    release[0]?.()
    await settle()

    expect(started).toEqual(["a", "ab"])
    expect(display(editor)).toContain("> fresh")
    expect(display(editor)).not.toContain("stale")
    editor.minibufferCancel()
    await result
  })

  test("cancelling the prompt aborts the in-flight query", async () => {
    let seenSignal: AbortSignal | null = null
    const { editor, result } = openDynamic(async (_input, signal) => {
      seenSignal = signal
      await new Promise(resolve => setTimeout(resolve, 500))
      return ["late"]
    })
    await editor.handleKey({ name: "x", sequence: "x" })
    await settle()
    editor.minibufferCancel()
    await result
    expect(seenSignal!.aborted).toBe(true)
  })

  test("the count line marks a query that has not answered yet", async () => {
    const { editor, result } = openDynamic(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
      return ["done"]
    })
    await editor.handleKey({ name: "x", sequence: "x" })
    // Still inside the debounce window: the display says a query is pending, not "no matches".
    expect(display(editor)).toContain("...")
    await settle()
    expect(display(editor)).toContain("1/1")
    expect(display(editor)).not.toContain("...")
    editor.minibufferCancel()
    await result
  })

  test("keystrokes inside the debounce window collapse into one query", async () => {
    const queries: string[] = []
    const { editor, result } = openDynamic(async input => {
      queries.push(input)
      return [input]
    })
    // Three fast keystrokes: the first two are still debouncing when the next one lands.
    for (const key of ["a", "b", "c"]) await editor.handleKey({ name: key, sequence: key })
    await settle()
    expect(queries).toEqual(["abc"])
    editor.minibufferCancel()
    await result
  })

  test("vertico-exit returns the highlighted dynamic candidate", async () => {
    const { editor, result } = openDynamic(async input => [`${input}-one`, `${input}-two`])
    await editor.handleKey({ name: "z", sequence: "z" })
    await settle()
    await editor.run("vertico-next")
    await editor.run("vertico-exit")
    await expect(result).resolves.toBe("z-two")
  })
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

// Regression: `C-x C-f` on a directory preselects the prompt (index -1) so RET
// visits the typed directory. No candidate row is marked `> ` in that state, and
// nothing else was highlighted either, so the list looked inert. Emacs paints the
// prompt line with `vertico-current'; `promptSelected` is what carries that.
describe("preselected prompt is still visibly selected", () => {
  test("a directory prompt marks no candidate but flags the prompt line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vertico-preselect-"))
    await writeFile(join(dir, "a.txt"), "")
    await writeFile(join(dir, "b.txt"), "")

    const editor = makeEditor()
    install(editor)
    editor.enableMinorMode("vertico-mode")
    const result = editor.prompt("Find file: ", `${dir}/`, undefined, { completion: "file" })
    await editor.refreshMinibufferCompletions()

    expect(display(editor)).toContain("*/2")
    expect(display(editor)).not.toContain("> ")
    expect(editor.minibufferCompletionDisplay?.selectedLine).toBeUndefined()
    expect(editor.minibufferCompletionDisplay?.promptSelected).toBe(true)

    // Moving onto a candidate hands the highlight back to the list.
    await editor.run("vertico-next")
    expect(display(editor)).toContain("> ")
    expect(editor.minibufferCompletionDisplay?.selectedLine).toBe(1)
    expect(editor.minibufferCompletionDisplay?.promptSelected).toBe(false)

    editor.minibufferCancel()
    await result
  })
})

// Regression: `C-x C-f` preselects the prompt, so the whole input already wore a
// background. Painting the mark with that same face made `C-SPC` invisible: the
// row looked identical before and after marking.
describe("mark stays visible on a preselected prompt", () => {
  test("the marked span differs from the rest of the prompt row", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vertico-mark-"))
    await writeFile(join(dir, "a.txt"), "")

    const editor = makeEditor()
    install(editor)
    editor.enableMinorMode("vertico-mode")
    const result = editor.prompt("Find file: ", `${dir}/`, undefined, { completion: "file" })
    await editor.refreshMinibufferCompletions()
    expect(editor.minibufferCompletionDisplay?.promptSelected).toBe(true)

    const regionBg = editor.theme.faces.region?.bg
    const marked = () => displayModel(editor).minibuffer.chunks.some(c => c.bg === regionBg)
    expect(marked()).toBe(false)

    const buffer = editor.activeBuffer
    buffer.setMark()
    buffer.move(-4)
    expect(buffer.markActive).toBe(true)
    expect(marked()).toBe(true)

    editor.minibufferCancel()
    await result
  })
})

describe("vertico-exit-input", () => {
  test("RET submits literal file prompt text when there are zero candidates", async () => {
    const editor = makeEditor()
    install(editor)
    editor.enableMinorMode("vertico-mode")
    const input = "/ssh:user@192.168.0.29:/"
    const result = editor.prompt("Find: ", input, undefined, { completion: "file" })
    await editor.refreshMinibufferCompletions()
    expect(display(editor)).toContain("*/0")

    await editor.handleKey({ name: "return" })
    await expect(result).resolves.toBe(input)
  })

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

describe("vertico refresh after minibuffer edits", () => {
  test("forward deletion recomputes candidates like vertico post-command update", async () => {
    const { editor, result } = await open(["alpha", "beta"])

    await editor.handleKey({ name: "a", sequence: "a" })
    expect(display(editor)).toContain("1/1")
    expect(display(editor)).toContain("> alpha")
    expect(display(editor)).not.toContain("beta")

    await editor.run("backward-char")
    await editor.run("delete-char")
    expect(editor.minibufferInput()).toBe("")
    expect(display(editor)).toContain("1/2")
    expect(display(editor)).toContain("> beta")
    expect(display(editor)).toContain("alpha")

    editor.minibufferCancel()
    await result
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

// Layer 2: the flag above is only useful if the renderer actually paints it. The
// prompt input must carry the same background the selected candidate row gets,
// which is `highlight' and not `region' — `region' stays reserved for the mark.
describe("preselected prompt reaches the display model", () => {
  test("the minibuffer input renders with the highlight background", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vertico-preselect-display-"))
    await writeFile(join(dir, "a.txt"), "")

    const editor = makeEditor()
    install(editor)
    editor.enableMinorMode("vertico-mode")
    const result = editor.prompt("Find file: ", `${dir}/`, undefined, { completion: "file" })
    await editor.refreshMinibufferCompletions()

    const highlightBg = editor.theme.faces.highlight?.bg
    expect(highlightBg).toBeTruthy()
    expect(highlightBg).not.toBe(editor.theme.faces.region?.bg)
    const promptSelected = displayModel(editor).minibuffer.chunks.some(c => c.text.includes(dir) && c.bg === highlightBg)
    expect(promptSelected).toBe(true)

    // Once a candidate is current the prompt drops back to the plain face.
    await editor.run("vertico-next")
    const stillSelected = displayModel(editor).minibuffer.chunks.some(c => c.text.includes(dir) && c.bg === highlightBg)
    expect(stillSelected).toBe(false)

    editor.minibufferCancel()
    await result
  })
})
