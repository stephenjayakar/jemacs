import { expect, test } from "bun:test"
import { makeEditor } from "../plugins/helper"
import { install as installFido } from "../../plugins/fido/index"
import { install as installVertico } from "../../plugins/vertico"

// fido binds minibuffer C-s/C-r to icomplete-*-completions at install(). Those
// commands stop early while vertico owns the frontend, so C-s/C-r did nothing in
// find-file. Vertico must claim both keys.
test("minibuffer C-s/C-r move the vertico selection when fido loaded first", async () => {
  const editor = makeEditor()
  installFido(editor)
  editor.disableMinorMode("fido-vertical-mode")
  installVertico(editor)
  editor.enableMinorMode("vertico-mode")

  void editor.prompt("Pick: ", "", undefined, { collection: ["alpha", "beta", "gamma"] })
  await editor.refreshMinibufferCompletions()

  await editor.handleKey({ name: "s", ctrl: true, sequence: "\u0013" })
  expect(editor.minibufferCompletionDisplay?.text.split("\n")[0]).toContain("2/3")

  await editor.handleKey({ name: "r", ctrl: true, sequence: "\u0012" })
  expect(editor.minibufferCompletionDisplay?.text.split("\n")[0]).toContain("1/3")
})
