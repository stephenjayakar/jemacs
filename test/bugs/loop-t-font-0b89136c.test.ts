import { expect, test } from "bun:test"
import { defineTheme } from "../../src/display/theme-types"
import { getFaceRegistrySpec, resetFace, resolveFace, setFaceAttribute } from "../../src/runtime/faces"

// t-font-0b89136c: setFaceAttribute("default","family","Fira Code") with no
// generic-family suffix becomes `font-family: "Fira Code"` in the host CSS, so
// a machine without Fira Code falls back to the UA default (serif). The fix
// appends a generic fallback — monospace for fixed-pitch contexts (default),
// sans-serif for variable-pitch — and warns once.
test("setFaceAttribute family without generic fallback appends one", () => {
  resetFace("default")
  setFaceAttribute("default", "family", "Fira Code")
  const resolved = resolveFace("default", defineTheme("t", {}))
  expect(resolved?.family).toMatch(/,\s*monospace$/)
  expect(resolved?.family).toContain("Fira Code")

  resetFace("variable-pitch")
  setFaceAttribute("variable-pitch", "family", "Helvetica Neue")
  const vp = getFaceRegistrySpec("variable-pitch")
  expect(vp?.family).toMatch(/,\s*sans-serif$/)

  // A value that already has a generic suffix is left alone.
  resetFace("default")
  setFaceAttribute("default", "family", "JetBrains Mono, monospace")
  const already = resolveFace("default", defineTheme("t", {}))
  expect(already?.family).toBe("JetBrains Mono, monospace")

  resetFace("default")
  resetFace("variable-pitch")
})
