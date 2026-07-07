import { describe, expect, test } from "bun:test"
import { install } from "../../plugins/abbrev"
import { script } from "../harness/script"

const SPACE = { name: "space", sequence: " " }

function setup() {
  return script({ plugins: false }).do(async editor => {
    await install(editor)
    await editor.run("kill-all-abbrevs")
  })
}

describe("abbrev-mode", () => {
  test("define-global-abbrev records an abbrev", async () => {
    await setup()
      .run("define-global-abbrev", "btw", "by the way")
      .run("list-abbrevs")
      .expect.bufferName("*Abbrevs*")
      .expect.that((_editor, buffer) => {
        expect(buffer.text).toContain("Global abbrevs:")
        expect(buffer.text).toContain("btw -> by the way")
      })
      .done()
  })

  test("typing a non-word character expands a global abbrev", async () => {
    await setup()
      .run("define-global-abbrev", "teh", "the")
      .run("abbrev-mode")
      .text("")
      .keys("t", "e", "h", SPACE)
      .expect.text("the ")
      .expect.point(4)
      .done()
  })

  test("disabled abbrev-mode does not expand", async () => {
    await setup()
      .run("define-global-abbrev", "teh", "the")
      .text("")
      .keys("t", "e", "h", SPACE)
      .expect.text("teh ")
      .done()
  })

  test("mode-local abbrev only fires in that major mode", async () => {
    await setup()
      .mode("javascript")
      .run("define-mode-abbrev", "fn", "function")
      .run("abbrev-mode")
      .mode("text")
      .text("")
      .keys("f", "n", SPACE)
      .expect.text("fn ")
      .mode("javascript")
      .text("")
      .keys("f", "n", SPACE)
      .expect.text("function ")
      .done()
  })
})
