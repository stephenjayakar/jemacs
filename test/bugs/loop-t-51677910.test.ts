import { expect, test } from "bun:test"
import { script, keySeq, spans } from "../harness"

// t-51677910: query-replace moved point to each match but painted no overlay,
// so the user confirmed a replacement they couldn't see the extent of. Real
// Emacs gives the current match the `isearch`/query-replace face. The overlay
// must be live while readKey is waiting and cleared once the loop exits.

const tick = () => new Promise<void>(r => queueMicrotask(() => queueMicrotask(r)))

test("query-replace highlights the current match while prompting", async () => {
  const ed = await script({ plugins: false }).text("foo bar foo").point(0).done()
  const buf = ed.currentBuffer
  const done = ed.run("query-replace", ["foo", "baz"])
  await tick() // let the command reach its first readKey

  // First match at 0..3 painted with the isearch face via addOverlaySource.
  let hl = ed.fontLock(buf).filter(s => s.face === "isearch")
  expect(hl).toEqual([{ start: 0, end: 3, face: "isearch" }])
  // And it reaches the display model (same path avy/smerge use).
  expect(spans(ed).some(s => s.face === "isearch" && s.start === 0 && s.end === 3)).toBe(true)

  await keySeq(ed, "n") // skip → overlay moves to the next match at 8..11
  hl = ed.fontLock(buf).filter(s => s.face === "isearch")
  expect(hl).toEqual([{ start: 8, end: 11, face: "isearch" }])

  await keySeq(ed, "y") // replace second; no further matches → loop ends
  await done
  expect(buf.text).toBe("foo bar baz")
  // Overlay cleared after the command finishes.
  expect(ed.fontLock(buf).filter(s => s.face === "isearch")).toEqual([])
})

test("query-replace overlay is cleared on quit", async () => {
  const ed = await script({ plugins: false }).text("xx").point(0).done()
  const done = ed.run("query-replace", ["x", "y"])
  await tick()
  expect(ed.fontLock(ed.currentBuffer).some(s => s.face === "isearch")).toBe(true)
  await keySeq(ed, "q")
  await done
  expect(ed.fontLock(ed.currentBuffer).some(s => s.face === "isearch")).toBe(false)
})
