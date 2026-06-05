import { expect, test } from "bun:test"
import { makeEditor } from "../plugins/helper"
import { applyKeyBinding, getKeyBinding } from "../../src/runtime/key-registry"

// t-159210e5: editor.key()/defineKey() registered under "global-map" but
// applyKeyBinding passed the raw map alias to registerKeyBinding, so
// getKeyBinding('global',seq) and getKeyBinding('global-map',seq) hit
// different entries and describe-key/restore-key picked the wrong one.
test("key registry: map-name aliases resolve to one canonical entry", () => {
  const editor = makeEditor()
  editor.key("C-c 9 9", "demo-hello")
  applyKeyBinding(editor, "global", "C-c 9 9", "demo-goodbye")
  const a = getKeyBinding("global", "C-c 9 9")
  const b = getKeyBinding("global-map", "C-c 9 9")
  expect(a).toBe(b)
  expect(b?.command).toBe("demo-goodbye")
  expect(b?.map).toBe("global-map")
})
