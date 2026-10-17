import { expect, test } from "bun:test"
import { makeEditor } from "../plugins/helper"
import { install as installFido } from "../../plugins/fido/index"
import { install as installVertico } from "../../plugins/vertico"
import { buildLogicalModel } from "../../src/display/logical"

const C_R = { name: "r", ctrl: true, sequence: "\u0012" }
const C_S = { name: "s", ctrl: true, sequence: "\u0013" }
const C_G = { name: "g", ctrl: true, sequence: "\u0007" }

function verticoEditor() {
  const editor = makeEditor()
  installFido(editor)
  editor.disableMinorMode("fido-vertical-mode")
  installVertico(editor)
  editor.enableMinorMode("vertico-mode")
  editor.minibufferHistory.set("pick", ["alpha", "beta", "gamma"])
  return editor
}

async function type(editor: ReturnType<typeof makeEditor>, text: string) {
  for (const ch of text) await editor.handleKey({ name: ch, sequence: ch })
}

// fido binds minibuffer C-s/C-r to icomplete-*-completions at install(). vertico-map
// leaves them alone, so in GNU they fall through to isearch, which walks minibuffer
// history (minibuffer-history-isearch).
test("minibuffer C-r isearches backward through history under vertico", async () => {
  const editor = verticoEditor()
  void editor.prompt("Pick: ", "zz", "pick", { collection: ["alpha", "beta", "gamma"] })
  await editor.refreshMinibufferCompletions()

  await editor.handleKey(C_R)
  expect(buildLogicalModel(editor).minibuffer?.prompt).toBe(" I-search backward: ")

  await type(editor, "a")
  expect(editor.activeBuffer.text).toBe("gamma")
  expect(editor.activeBuffer.point).toBe(4)

  // Repeat: earlier match in the same element, then the next older element.
  await editor.handleKey(C_R)
  expect(editor.activeBuffer.text).toBe("gamma")
  expect(editor.activeBuffer.point).toBe(1)
  await editor.handleKey(C_R)
  expect(editor.activeBuffer.text).toBe("beta")
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(editor.minibufferCompletionDisplay?.text).toContain("beta")

  // C-s searches forward again, back toward the newest element.
  await editor.handleKey(C_S)
  await editor.handleKey(C_S)
  expect(editor.activeBuffer.text).toBe("gamma")

  // RET ends the search and keeps the recalled element; the minibuffer stays open.
  await editor.handleKey({ name: "return", sequence: "\r" })
  expect(editor.isearch).toBeNull()
  expect(editor.minibuffer).not.toBeNull()
  expect(editor.activeBuffer.text).toBe("gamma")
})

test("C-g in minibuffer isearch drops the failing tail, then restores the input", async () => {
  const editor = verticoEditor()
  const result = editor.prompt("Pick: ", "zz", "pick", { collection: ["alpha", "beta", "gamma"] })
  await editor.refreshMinibufferCompletions()

  await editor.handleKey(C_R)
  await type(editor, "bq")
  expect(editor.activeBuffer.text).toBe("beta")
  expect(buildLogicalModel(editor).minibuffer?.prompt).toBe(" Failing I-search backward: ")

  await editor.handleKey(C_G)
  expect(editor.isearch?.string).toBe("b")
  expect(editor.activeBuffer.text).toBe("beta")

  await editor.handleKey(C_G)
  expect(editor.isearch).toBeNull()
  expect(editor.minibuffer).not.toBeNull()
  expect(editor.activeBuffer.text).toBe("zz")

  await editor.handleKey(C_G)
  expect(await result).toBeNull()
})
