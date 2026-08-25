import { describe, expect, test } from "bun:test"
import { inferMode } from "../src/kernel/buffer"
import { installDefaultModes } from "../src/modes/default-modes"
import { modes } from "../src/modes/mode"

/**
 * Every file type Stephen's Emacs config associates with a major mode, and the jemacs
 * mode it must resolve to. Guards against a language package silently losing its
 * association during a refactor.
 */
const ASSOCIATIONS: Array<[string, string]> = [
  ["a.go", "go"],
  ["a.rs", "rust"],
  ["a.proto", "protobuf"],
  ["a.tf", "terraform"],
  ["a.hbs", "handlebars"],
  ["a.handlebars", "handlebars"],
  ["a.glsl", "glsl"],
  ["a.http", "restclient"],
  ["a.py", "python"],
  ["a.ts", "typescript"],
  ["a.mmd", "mermaid"],
  ["a.mermaid", "mermaid"],
]

describe("Emacs file associations", () => {
  test("every configured extension infers the expected mode", () => {
    for (const [path, mode] of ASSOCIATIONS) {
      expect({ path, mode: inferMode(path) }).toEqual({ path, mode })
    }
  })

  test("every inferred mode is actually registered", () => {
    installDefaultModes()
    for (const [path, mode] of ASSOCIATIONS) {
      expect({ path, registered: modes.get(mode) != null })
        .toEqual({ path, registered: true })
    }
  })
})
