import { expect, test } from "bun:test"
import { defcustom, getCustom, getCustomVariable, setCustom } from "../../src/runtime/custom"
import { getCatalogEntry } from "../../src/runtime/definitions"

// t-f43266b4: defcustom re-eval (hot reload) early-returns to preserve the user
// value, but must still refresh doc/type/source/baseline so describe-variable
// and the customize catalog reflect the edited definition.
test("defcustom: re-eval updates doc/type/source metadata while preserving value", () => {
  defcustom("t-f43266b4-a", "string", "v1", "old doc", "old-group")
  setCustom("t-f43266b4-a", "user")
  const before = getCustomVariable("t-f43266b4-a")!.source

  defcustom("t-f43266b4-a", "sexp", "v2", "new doc", "new-group")

  const v = getCustomVariable("t-f43266b4-a")!
  expect(getCustom("t-f43266b4-a")).toBe("user") // value preserved
  expect(v.doc).toBe("new doc")
  expect(v.type).toBe("sexp")
  expect(v.group).toBe("new-group")
  expect(v.baselineValue).toBe("v2")
  expect(v.source?.line).not.toBe(before?.line) // re-captured at re-eval site

  const entry = getCatalogEntry({ kind: "variable", name: "t-f43266b4-a" })
  expect(entry?.doc).toBe("new doc")
  expect(entry?.source?.line).toBe(v.source?.line)
})

test("defcustom: re-eval without user customization still keeps first value but refreshes metadata", () => {
  defcustom("t-f43266b4-b", "number", 1, "first")
  defcustom("t-f43266b4-b", "number", 2, "second")
  expect(getCustom("t-f43266b4-b")).toBe(1) // set-if-unbound semantics retained
  expect(getCustomVariable("t-f43266b4-b")?.doc).toBe("second")
  expect(getCustomVariable("t-f43266b4-b")?.baselineValue).toBe(2)
})
