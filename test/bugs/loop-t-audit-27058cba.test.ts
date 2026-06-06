import { expect, test } from "bun:test"
import { defcustom, getCustom, setCustom } from "../../src/runtime/custom"

// t-audit-27058cba: defcustom re-eval (hot reload) must not clobber a value the
// user already customized — set-if-unbound, same as defvar (DESIGN.md §hot-reload).
test("defcustom: re-eval preserves user-customized value", () => {
  defcustom("t-audit-27058cba-a", "string", "default")
  setCustom("t-audit-27058cba-a", "user")
  defcustom("t-audit-27058cba-a", "string", "default")
  expect(getCustom("t-audit-27058cba-a")).toBe("user")
})

test("defcustom: re-eval is set-if-unbound", () => {
  defcustom("t-audit-27058cba-b", "number", 1)
  defcustom("t-audit-27058cba-b", "number", 2)
  expect(getCustom("t-audit-27058cba-b")).toBe(1)
})
