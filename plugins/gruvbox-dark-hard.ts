import type { Editor } from "../src/kernel/editor"
import { defineTheme } from "../src/display/theme"
import { registerTheme } from "../src/themes"

/** Gruvbox dark hard palette (24-bit GUI colors from emacs-theme-gruvbox). */
export const gruvboxDarkHardPalette = {
  dark0_hard: "#1d2021",
  dark0: "#282828",
  dark1: "#3c3836",
  dark2: "#504945",
  dark3: "#665c54",
  dark4: "#7c6f64",
  light1: "#ebdbb2",
  light2: "#d5c4a1",
  light3: "#bdae93",
  light4: "#a89984",
  bright_red: "#fb4933",
  bright_green: "#b8bb26",
  bright_yellow: "#fabd2f",
  bright_blue: "#83a598",
  bright_purple: "#d3869b",
  bright_orange: "#fe8019",
  bright_aqua: "#8ec07c",
  faded_blue: "#458588",
} as const

/**
 * Gruvbox dark hard — matches `custom-enabled-themes '(gruvbox-dark-hard)` in ~/.emacs.d.
 * Face mapping follows emacs-theme-gruvbox (font-lock, mode-line, isearch, etc.).
 */
export const gruvboxDarkHardTheme = defineTheme("gruvbox-dark-hard", {
  default: { fg: gruvboxDarkHardPalette.light1, bg: gruvboxDarkHardPalette.dark0_hard },
  keyword: { fg: gruvboxDarkHardPalette.bright_red, bold: true },
  string: { fg: gruvboxDarkHardPalette.bright_green },
  comment: { fg: gruvboxDarkHardPalette.dark4, italic: true },
  builtin: { fg: gruvboxDarkHardPalette.bright_orange },
  function: { fg: gruvboxDarkHardPalette.bright_yellow },
  type: { fg: gruvboxDarkHardPalette.bright_purple },
  number: { fg: gruvboxDarkHardPalette.bright_purple },
  constant: { fg: gruvboxDarkHardPalette.bright_purple },
  directory: { fg: gruvboxDarkHardPalette.bright_blue, bold: true },
  region: { bg: gruvboxDarkHardPalette.dark2 },
  isearch: { fg: gruvboxDarkHardPalette.dark0_hard, bg: gruvboxDarkHardPalette.bright_orange },
  modeLine: { fg: gruvboxDarkHardPalette.light2, bg: gruvboxDarkHardPalette.dark3 },
  modeLineInactive: { fg: gruvboxDarkHardPalette.light4, bg: gruvboxDarkHardPalette.dark1 },
  minibuffer: { fg: gruvboxDarkHardPalette.light1, bg: gruvboxDarkHardPalette.dark1 },
  minibufferPrompt: { fg: gruvboxDarkHardPalette.bright_green, bold: true },
  title: { fg: gruvboxDarkHardPalette.light3, bg: gruvboxDarkHardPalette.dark0 },
  error: { fg: gruvboxDarkHardPalette.bright_red, bold: true },
  lineNumber: { fg: gruvboxDarkHardPalette.dark4, bg: gruvboxDarkHardPalette.dark1 },
  lineNumberCurrent: { fg: gruvboxDarkHardPalette.bright_orange, bg: gruvboxDarkHardPalette.dark2 },
})

export function install(_editor: Editor): void {
  registerTheme(gruvboxDarkHardTheme)
}
