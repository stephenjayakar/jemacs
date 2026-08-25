import { describe, expect, test } from "bun:test"
import { script, keySeq, display } from "./harness"
import type { Editor } from "../src/kernel/editor"
import { themedTextPlain } from "../src/display/themed-text"

/** Resolve on the next "minibuffer" event, then unsubscribe so a later event needs a fresh wait. */
function nextMinibuffer(editor: Editor): Promise<string> {
  return new Promise(resolve => {
    const off = editor.events.on("minibuffer", ({ prompt }) => {
      off()
      resolve(prompt)
    })
  })
}

describe("recursive minibuffer", () => {
  test("M-x while inside C-x C-f pushes a second minibuffer", async () => {
    const ed = await script({ plugins: false }).done()

    const opened1 = nextMinibuffer(ed)
    void keySeq(ed, "C-x", "C-f")
    expect(await opened1).toBe("Find file: ")
    expect(ed.minibufferDepthLevel).toBe(1)
    expect(ed.minibuffer?.historyName).toBe("file")
    expect(ed.activeBuffer.name).toBe(" *Minibuffer-1*")

    const opened2 = nextMinibuffer(ed)
    void keySeq(ed, "M-x")
    expect(await opened2).toBe("M-x ")
    expect(ed.minibufferDepthLevel).toBe(2)
    expect(ed.minibuffer?.prompt).toBe("M-x ")
    expect(ed.minibuffer?.historyName).toBe("command")
    expect(ed.activeBuffer.name).toBe(" *Minibuffer-2*")

    // layer-2: depth indicator renders in the minibuffer prompt
    const mbLine = themedTextPlain(display(ed).minibuffer)
    expect(mbLine).toContain("[2]")
    expect(mbLine).toContain("M-x")

    // unwind both levels so the void'd key chains settle
    await keySeq(ed, "C-g")
    await keySeq(ed, "C-g")
    expect(ed.minibuffer).toBeNull()
  })

  test("C-g at depth 2 returns to depth 1, not to top-level", async () => {
    const ed = await script({ plugins: false }).done()

    const opened1 = nextMinibuffer(ed)
    void keySeq(ed, "C-x", "C-f")
    await opened1
    const inputAtDepth1 = ed.minibufferInput()
    const depth1BufferId = ed.minibuffer!.bufferId

    const opened2 = nextMinibuffer(ed)
    void keySeq(ed, "M-x")
    await opened2
    expect(ed.minibufferDepthLevel).toBe(2)
    const depth2BufferId = ed.minibuffer!.bufferId
    expect(depth2BufferId).not.toBe(depth1BufferId)

    await keySeq(ed, "C-g")

    // back at the find-file prompt with its original input intact
    expect(ed.minibufferDepthLevel).toBe(1)
    expect(ed.minibuffer?.prompt).toBe("Find file: ")
    expect(ed.minibuffer?.bufferId).toBe(depth1BufferId)
    expect(ed.minibufferInput()).toBe(inputAtDepth1)
    expect(ed.activeBuffer.name).toBe(" *Minibuffer-1*")
    expect(ed.buffers.has(depth2BufferId)).toBe(false)
    expect(themedTextPlain(display(ed).minibuffer)).not.toContain("[2]")

    // second C-g exits to top-level
    await keySeq(ed, "C-g")
    expect(ed.minibufferDepthLevel).toBe(0)
    expect(ed.minibuffer).toBeNull()
    expect(ed.buffers.has(depth1BufferId)).toBe(false)
  })

  test("history is isolated per name across depths", async () => {
    const ed = await script({ plugins: false }).done()
    ed.minibufferHistory.set("file", ["/tmp/a.txt"])
    ed.minibufferHistory.set("command", ["forward-char"])

    const opened1 = nextMinibuffer(ed)
    void keySeq(ed, "C-x", "C-f")
    await opened1
    await keySeq(ed, "up")
    expect(ed.minibufferInput()).toBe("/tmp/a.txt")

    const opened2 = nextMinibuffer(ed)
    void keySeq(ed, "M-x")
    await opened2
    expect(ed.minibuffer?.historyName).toBe("command")
    // M-x's <up> must pull from "command", never the outer "file" list
    await keySeq(ed, "up")
    expect(ed.minibufferInput()).toBe("forward-char")

    // cancelling the inner minibuffer must not write to either history
    await keySeq(ed, "C-g")
    expect(ed.minibufferHistory.get("command")).toEqual(["forward-char"])
    expect(ed.minibufferHistory.get("file")).toEqual(["/tmp/a.txt"])

    // depth-1 buffer state survived the recursion
    expect(ed.minibufferInput()).toBe("/tmp/a.txt")

    await keySeq(ed, "C-g")
    expect(ed.minibuffer).toBeNull()
  })

  test("submit at depth 2 records to its own history name only", async () => {
    const ed = await script({ plugins: false }).done()

    // Use bare prompts so we control the history names without find-file's cwd prefill.
    const outer = ed.prompt("Outer: ", "", "outer-hist")
    expect(ed.minibufferDepthLevel).toBe(1)
    const inner = ed.prompt("Inner: ", "", "inner-hist")
    expect(ed.minibufferDepthLevel).toBe(2)

    await keySeq(ed, "x", "y")
    expect(ed.minibufferInput()).toBe("xy")
    await keySeq(ed, "RET")
    expect(await inner).toBe("xy")

    expect(ed.minibufferDepthLevel).toBe(1)
    expect(ed.minibuffer?.historyName).toBe("outer-hist")
    expect(ed.minibufferHistory.get("inner-hist")).toEqual(["xy"])
    expect(ed.minibufferHistory.get("outer-hist")).toBeUndefined()

    ed.minibufferCancel()
    expect(await outer).toBeNull()
    expect(ed.minibufferHistory.get("outer-hist")).toBeUndefined()
  })
})

// Regression: the minibuffer is a real buffer, so C-SPC sets a mark there, but
// `logicalMinibuffer` dropped it and the prompt row was painted as one flat
// span. Marking in the `C-x C-f` prompt therefore had no visible effect.
describe("minibuffer region", () => {
  test("C-SPC then motion paints the region on the prompt row", async () => {
    const ed = await script({ plugins: false }).done()
    const opened = nextMinibuffer(ed)
    void keySeq(ed, "M-x")
    await opened

    for (const ch of "abcdef") await keySeq(ed, ch)
    expect(ed.minibufferInput()).toBe("abcdef")

    const regionBg = ed.theme.faces.region?.bg
    expect(regionBg).toBeTruthy()
    const marked = () => display(ed).minibuffer.chunks.some(c => c.bg === regionBg)

    // No mark yet, so nothing on the row wears the region face.
    expect(marked()).toBe(false)

    await keySeq(ed, "C-SPC")
    await keySeq(ed, "C-b")
    await keySeq(ed, "C-b")
    expect(ed.activeBuffer.markActive).toBe(true)
    expect(marked()).toBe(true)
    // Exactly the two characters between point and mark are highlighted; the
    // cursor glyph stands in for the "e" it overwrites.
    const highlighted = display(ed).minibuffer.chunks.filter(c => c.bg === regionBg).map(c => c.text).join("")
    expect(highlighted).toBe("█f")

    // Deactivating the mark clears the highlight again.
    await keySeq(ed, "C-g")
    expect(ed.activeBuffer.markActive).toBe(false)
    expect(marked()).toBe(false)

    await keySeq(ed, "C-g")
    expect(ed.minibuffer).toBeNull()
  })
})
