import type { BufferModel } from "../kernel/buffer"
import { Keymap } from "../kernel/keymap"
import { defineMode, type TextSpan } from "./mode"

export const HELP_BUTTONS_KEY = "jemacs-help-buttons"

export type HelpButton = {
  start: number
  end: number
  kind: "command" | "variable"
  name: string
}

export function installHelpMode(): void {
  const keymap = new Keymap("help-map")
  keymap.bind("return", "help-follow")
  keymap.bind("enter", "help-follow")
  keymap.bind("RET", "help-follow")
  keymap.bind("tab", "forward-button")
  keymap.bind("S-tab", "backward-button")
  keymap.bind("q", "quit-window")
  keymap.bind("g", "help-revert")
  keymap.bind("l", "help-go-back")
  keymap.bind("r", "help-go-forward")
  defineMode({
    name: "help",
    parent: "text",
    keymap,
    onEnter: buffer => { buffer.readOnly = true },
    fontLock: helpFontLock,
  })
}

export function helpFontLock(buffer: BufferModel): TextSpan[] {
  const buttons = helpButtons(buffer)
  return buttons.map(button => ({ start: button.start, end: button.end, face: "helpLink" }))
}

export function helpButtons(buffer: BufferModel): HelpButton[] {
  return (buffer.locals.get(HELP_BUTTONS_KEY) as HelpButton[] | undefined) ?? []
}

export function helpButtonAt(buffer: BufferModel, point = buffer.point): HelpButton | null {
  return helpButtons(buffer).find(button => point >= button.start && point <= button.end) ?? null
}

export function moveHelpButton(buffer: BufferModel, direction: 1 | -1): boolean {
  const buttons = helpButtons(buffer)
  if (!buttons.length) return false
  const point = buffer.point
  const target = direction > 0
    ? buttons.find(button => button.start > point) ?? buttons[0]
    : [...buttons].reverse().find(button => button.end < point) ?? buttons[buttons.length - 1]
  if (!target) return false
  buffer.point = target.start
  return true
}
