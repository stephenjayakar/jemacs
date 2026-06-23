import { Keymap } from "../kernel/keymap"
import { defineMode } from "./mode"

export function installHelpMode(): void {
  const keymap = new Keymap("help-map")
  keymap.bind("return", "help-follow")
  keymap.bind("enter", "help-follow")
  keymap.bind("RET", "help-follow")
  defineMode({
    name: "help",
    parent: "text",
    keymap,
    onEnter: buffer => { buffer.readOnly = true },
  })
}
