import { describe, expect, test } from "bun:test"
import { getMode } from "../../src/modes/mode"
import { install } from "../../plugins/magit"
import { parseBisectOutput } from "../../plugins/magit/bisect"
import { makeEditor } from "./helper"

describe("parseBisectOutput", () => {
  test("extracts the first bad commit sha", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567"
    expect(parseBisectOutput(`${sha} is the first bad commit\ncommit subject\n`)).toEqual({
      kind: "culprit",
      sha,
      line: `${sha} is the first bad commit`,
    })
  })

  test("extracts the current revisions-left line", () => {
    expect(parseBisectOutput("Bisecting: 3 revisions left to test after this (roughly 2 steps)\n[abc1234] subject\n")).toEqual({
      kind: "progress",
      line: "Bisecting: 3 revisions left to test after this (roughly 2 steps)",
    })
  })
})

test("magit bisect commands, keymap, and transient are wired", async () => {
  const editor = makeEditor()
  install(editor)

  for (const cmd of [
    "magit-bisect-popup",
    "magit-bisect-start",
    "magit-bisect-good",
    "magit-bisect-bad",
    "magit-bisect-skip",
    "magit-bisect-reset",
  ]) {
    expect(editor.commands.get(cmd)).toBeDefined()
  }

  const status = getMode("magit-status")
  expect(getMode("magit-mode")?.keymap?.get("S-b")).toBe("magit-bisect-popup")
  expect(status?.keymap?.get("S-b")).toBe("magit-bisect-popup")
  expect(status?.keymap?.get("S-b s")).toBe("magit-bisect-start")
  expect(status?.keymap?.get("S-b g")).toBe("magit-bisect-good")
  expect(status?.keymap?.get("S-b b")).toBe("magit-bisect-bad")
  expect(status?.keymap?.get("S-b k")).toBe("magit-bisect-skip")
  expect(status?.keymap?.get("S-b r")).toBe("magit-bisect-reset")

  await editor.run("magit-bisect-popup")
  expect(editor.transient?.definition.name).toBe("magit-bisect")
  expect(editor.transientDisplayText()).toContain("Bisect")
  expect(editor.transientDisplayText()).toContain("s        start")
  expect(editor.transientDisplayText()).toContain("g        good")
  expect(editor.transientDisplayText()).toContain("b        bad")
  expect(editor.transientDisplayText()).toContain("k        skip")
  expect(editor.transientDisplayText()).toContain("r        reset")
})
