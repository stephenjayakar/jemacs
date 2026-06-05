import { expect, test } from "bun:test"
import { makeEditor } from "../plugins/helper"
import { install as installFido } from "../../plugins/fido"
import { install as installVertico } from "../../plugins/vertico"

// t-fa555091: fido binds minibuffer RET → icomplete-fido-ret unconditionally at install().
// With vertico-mode also active (stephen config), RET fires fidoRet which reads fido's
// own candidates[selected=0] instead of vertico's selection — user scrolls vertico to
// candidate N, presses RET, gets fido's candidate 0.
test("fido RET defers to the active minibufferCompletionFrontend (vertico)", async () => {
  const editor = makeEditor()
  installFido(editor) // builtin: enables fido-vertical-mode, binds RET → icomplete-fido-ret
  installVertico(editor)
  editor.enableMinorMode("vertico-mode") // sets editor.minibufferCompletionFrontend

  const collection = ["echo", "alpha", "bravo", "delta", "charlie", "foxtrot"]
  const result = editor.completingRead("Pick: ", { collection })
  await Promise.resolve() // let verticoRefresh populate state

  // User navigates vertico (down/C-n are rebound to vertico-next by installVertico).
  await editor.run("vertico-next")
  await editor.run("vertico-next")

  // RET is still bound to icomplete-fido-ret. It must defer to minibufferSubmit()
  // → verticoFrontend.submitValue → vertico's selected candidate, not fido's index 0.
  await editor.handleKey({ name: "return" })
  const value = await result
  expect(value).not.toBe("echo") // fido's candidates[0] under flex sort
  expect(value).toBe("bravo") // vertico's index=2 after sort-by-length-then-alpha
})

test("fido RET still accepts fido's selection when no other frontend is active", async () => {
  const editor = makeEditor()
  installFido(editor)
  const result = editor.completingRead("Pick: ", { collection: ["apple", "apricot", "avocado"] })
  await editor.handleKey({ name: "a", sequence: "a" })
  await editor.handleKey({ name: "n", ctrl: true })
  await editor.handleKey({ name: "return" })
  await expect(result).resolves.toBe("apricot")
})
