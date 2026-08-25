/**
 * Parity tests for `custom-face-edit`, the face attribute checklist.
 *
 * Every expected buffer was captured from GNU Emacs 30.2 running
 * `emacs -Q --batch` over the same `defface`, with tabs resolved by Emacs
 * itself. The only normalisation is the button row: `emacs -Q` has no
 * custom-file, so it omits `[ Apply and Save ]`.
 */
import { expect, test } from "bun:test"
import { makeEditor } from "../plugins/helper"
import type { Editor } from "../../src/kernel/editor"
import { defgroup } from "../../src/runtime/custom"
import { defface, getCustomFace, resetFace } from "../../src/runtime/faces"
import { FACE_ATTRIBUTE_SPECS } from "../../src/modes/custom-face-attributes"

function lines(editor: Editor): string[] {
  return editor.currentBuffer.text.split("\n")
}

test("custom-face-edit lists Emacs's attributes, in cus-face.el's order", () => {
  // `custom-face-attributes` in GNU Emacs 30.2, by tag and in order.
  expect(FACE_ATTRIBUTE_SPECS.map(spec => spec.tag)).toEqual([
    "Font Family", "Font Foundry", "Width", "Height", "Weight", "Slant",
    "Underline", "Overline", "Strike-through", "Box around text",
    "Inverse-video", "Foreground", "Distant Foreground", "Background",
    "Stipple", "Extend", "Inherit",
  ])
})

test("a face with :weight bold renders the Emacs buffer verbatim", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defface("f-weight", { weight: "bold", bold: true }, "Weight doc.", "editing")
  await editor.run("customize-face", ["f-weight"])
  expect(lines(editor)).toEqual([
    "For help using this buffer, see [Easy Customization] in the [Emacs manual].",
    "",
    "                                         [ Search ]",
    "",
    "Operate on all settings in this buffer:",
    "[ Revert... ] [ Apply ] [ Apply and Save ]",
    "",
    "Hide [F Weight] face: [sample]",
    "   [ State ]: STANDARD.",
    "   Weight doc.",
    "   [X] Weight: [Value Menu] bold",
    "   Show All Attributes",
    "",
  ])
  resetFace("f-weight")
})

test("a scaled :height renders the Scale arm", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defface("f-scale", { heightScale: 1.2 }, "Scale doc.", "editing")
  await editor.run("customize-face", ["f-scale"])
  expect(lines(editor)).toEqual([
    "For help using this buffer, see [Easy Customization] in the [Emacs manual].",
    "",
    "                                         [ Search ]",
    "",
    "Operate on all settings in this buffer:",
    "[ Revert... ] [ Apply ] [ Apply and Save ]",
    "",
    "Hide [F Scale] face: [sample]",
    "   [ State ]: STANDARD.",
    "   Scale doc.",
    "   [X] Height: [Value Menu] Scale: 1.2",
    "   Show All Attributes",
    "",
  ])
  resetFace("f-scale")
})

test("an absolute :height renders the Font size in 1/10 pt arm", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defface("f-abs", { height: 140 }, "Abs doc.", "editing")
  await editor.run("customize-face", ["f-abs"])
  expect(lines(editor)).toEqual([
    "For help using this buffer, see [Easy Customization] in the [Emacs manual].",
    "",
    "                                         [ Search ]",
    "",
    "Operate on all settings in this buffer:",
    "[ Revert... ] [ Apply ] [ Apply and Save ]",
    "",
    "Hide [F Abs] face: [sample]",
    "   [ State ]: STANDARD.",
    "   Abs doc.",
    "   [X] Height: [Value Menu] Font size in 1/10 pt: 140",
    "   Show All Attributes",
    "",
  ])
  resetFace("f-abs")
})

test(":underline expands into the Color/Style/Position sub-widget", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defface("f-under", {
    underline: true,
    underlineSpec: { color: "foreground-color", style: "line", position: true },
  }, "Under doc.", "editing")
  await editor.run("customize-face", ["f-under"])
  expect(lines(editor)).toEqual([
    "For help using this buffer, see [Easy Customization] in the [Emacs manual].",
    "",
    "                                         [ Search ]",
    "",
    "Operate on all settings in this buffer:",
    "[ Revert... ] [ Apply ] [ Apply and Save ]",
    "",
    "Hide [F Under] face: [sample]",
    "   [ State ]: STANDARD.",
    "   Under doc.",
    "   [X] Underline: [Value Menu] On:",
    "       Color: [Value Menu] Foreground Color",
    "       Style: [Value Menu] Line",
    "       Position: [Value Menu] At Bottom Of Text",
    "   Show All Attributes",
    "",
  ])
  resetFace("f-under")
})

test(":inherit renders as a repeat of face links", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defface("f-inherit", { inherit: ["error"] as never }, "Inherit doc.", "editing")
  await editor.run("customize-face", ["f-inherit"])
  expect(lines(editor)).toEqual([
    "For help using this buffer, see [Easy Customization] in the [Emacs manual].",
    "",
    "                                         [ Search ]",
    "",
    "Operate on all settings in this buffer:",
    "[ Revert... ] [ Apply ] [ Apply and Save ]",
    "",
    "Hide [F Inherit] face: [sample]",
    "   [ State ]: STANDARD.",
    "   Inherit doc.",
    "   [X] Inherit:",
    "       [INS] [DEL] Face: [link] (sample) error",
    "       [INS]",
    "   Show All Attributes",
    "",
  ])
  resetFace("f-inherit")
})

test("Show All Attributes reveals every row and relabels the button", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defface("f-weight", { weight: "bold", bold: true }, "Weight doc.", "editing")
  await editor.run("customize-face", ["f-weight"])
  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("Show All Attributes")
  await editor.run("Custom-newline")
  // cus-edit.el's `custom-face-edit` visibility widget is
  // `:on "Hide Unused Attributes" :off "Show All Attributes"`.
  expect(lines(editor)).toEqual([
    "For help using this buffer, see [Easy Customization] in the [Emacs manual].",
    "",
    "                                         [ Search ]",
    "",
    "Operate on all settings in this buffer:",
    "[ Revert... ] [ Apply ] [ Apply and Save ]",
    "",
    "Hide [F Weight] face: [sample]",
    "   [ State ]: STANDARD.",
    "   Weight doc.",
    "   [ ] Font Family: ",
    "   [ ] Font Foundry: ",
    "   [ ] Width: [Value Menu] normal",
    "   [ ] Height: [Value Menu] Scale: 1.0",
    "   [X] Weight: [Value Menu] bold",
    "   [ ] Slant: [Value Menu] normal",
    "   [ ] Underline: [Value Menu] Off",
    "   [ ] Overline: [Value Menu] Off",
    "   [ ] Strike-through: [Value Menu] Off",
    "   [ ] Box around text: [Value Menu] Off",
    "   [ ] Inverse-video: [Value Menu] Off",
    "   [ ] Foreground: black          [ Choose ]  (sample)",
    "   [ ] Distant Foreground: black          [ Choose ]  (sample)",
    "   [ ] Background: black          [ Choose ]  (sample)",
    "   [ ] Stipple: [Value Menu] None",
    "   [ ] Extend: [Value Menu] Off",
    "   [ ] Inherit:",
    "       [INS]",
    "   Hide Unused Attributes",
    "",
  ])
  resetFace("f-weight")
})

test("attributes the display layer cannot draw still round-trip", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defface("f-inert", {}, "Inert doc.", "editing")

  // `:overline` has no terminal rendering, but Customize still edits it and
  // the value survives on the face.
  await editor.run("customize-face", ["f-inert"])
  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("Show All Attributes")
  await editor.run("Custom-newline")
  const buffer = editor.currentBuffer
  buffer.point = buffer.text.indexOf("[ ] Overline")
  await editor.run("Custom-newline")          // check the box
  await editor.run("Custom-set")
  expect(getCustomFace("f-inert")?.spec.overline).toBe(false)
  expect(editor.currentBuffer.text).toContain("[X] Overline:")
  resetFace("f-inert")
})

test("unchecking an attribute clears every FaceStyle key it owns", async () => {
  const editor = makeEditor()
  defgroup("editing", "Basic text editing facilities.")
  defface("f-clear", { heightScale: 1.5 }, "Clear doc.", "editing")

  await editor.run("customize-face", ["f-clear"])
  expect(editor.currentBuffer.text).toContain("[X] Height: [Value Menu] Scale: 1.5")
  editor.currentBuffer.point = editor.currentBuffer.text.indexOf("[X] Height")
  await editor.run("Custom-newline")
  await editor.run("Custom-set")
  // `:height` owns both `height` and `heightScale`, so both go.
  expect(getCustomFace("f-clear")?.spec.height).toBeUndefined()
  expect(getCustomFace("f-clear")?.spec.heightScale).toBeUndefined()
  resetFace("f-clear")
})
