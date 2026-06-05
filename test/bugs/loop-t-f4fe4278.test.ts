import { expect, test } from "bun:test"
import { makeEditor } from "../plugins/helper"
import { displayRows } from "../harness/display"
import { install, orgFontLock } from "../../plugins/org"

const NOTES = [
  "* TODO Design the remote architecture",   // 0
  "** State sync protocol",                  // 1
  "   SSP-style diffing against last ack.",  // 2
  "** TODO Shadow kernel",                   // 3
  "   Same code both sides.",                // 4
  "* DONE Ship the sprint",                  // 5
  "** Squash and push",                      // 6
  "* Inbox",                                 // 7
].join("\n")

function setup() {
  const editor = makeEditor()
  install(editor)
  const buffer = editor.scratch("notes.org", NOTES, "org-mode")
  buffer.point = 0
  return { editor, buffer }
}

const bodyText = (rows: string[]) => rows.join("\n").replace(/▮/g, "")

// t-f4fe4278: org-cycle updates buffer.locals['org-folded'] but the display
// layer never consults it, so TAB visually does nothing.
test("TAB on a headline visually hides its subtree (layer 2)", async () => {
  const { editor } = setup()

  const before = bodyText(displayRows(editor))
  expect(before).toContain("State sync protocol")
  expect(before).toContain("Shadow kernel")

  await editor.run("org-cycle") // → FOLDED: lines 1..4 hidden
  const folded = bodyText(displayRows(editor))
  expect(folded).not.toContain("State sync protocol")
  expect(folded).not.toContain("Shadow kernel")
  expect(folded).toContain("Design the remote architecture...")
  expect(folded).toContain("* DONE Ship the sprint") // sibling untouched
  expect(folded).not.toBe(before)

  await editor.run("org-cycle") // → CHILDREN: direct ** visible, bodies hidden
  const children = bodyText(displayRows(editor))
  expect(children).toContain("** State sync protocol")
  expect(children).toContain("** TODO Shadow kernel")
  expect(children).not.toContain("SSP-style diffing")
  expect(children).not.toContain("Same code both sides")

  await editor.run("org-cycle") // → SUBTREE: everything visible again
  expect(bodyText(displayRows(editor))).toBe(before)
})

// t-7cff330a (merged): face:'error' is underline-only in both shipped themes,
// so TODO renders as default-fg-underline while titles steal the bold-red
// 'keyword' face — inverted from emacs org.
test("font-lock: TODO pops as keyword, headline title is the calm face", () => {
  const { buffer } = setup()
  const spans = orgFontLock(buffer)
  const faceAt = (needle: string) =>
    spans.find(s => s.start <= NOTES.indexOf(needle) && NOTES.indexOf(needle) < s.end)?.face
  expect(faceAt("TODO")).toBe("keyword")
  expect(faceAt("DONE")).toBe("string")
  expect(faceAt("Design the remote architecture")).toBe("function")
  // regression guard: the old inverted mapping
  expect(faceAt("TODO")).not.toBe("error")
  expect(faceAt("Design the remote architecture")).not.toBe("keyword")
})
