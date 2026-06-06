import { expect, test } from "bun:test"
import { smergeFindConflicts } from "../../plugins/smerge"

// t-audit-129fda4c — smergeFindConflicts spins forever on a conflict missing
// `=======`. parseConflict's nested-begin check execs BEGIN_RE and a failed
// exec resets BEGIN_RE.lastIndex to 0; on a null parse the outer loop never
// restores it and re-matches the same begin marker forever.
test("smergeFindConflicts terminates on malformed conflict (no =======)", () => {
  const text = "<<<<<<< HEAD\nmine\n>>>>>>> branch\n"
  expect(smergeFindConflicts(text)).toEqual([])
})
