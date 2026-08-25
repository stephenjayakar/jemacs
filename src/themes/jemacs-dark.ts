import { defineTheme } from "../display/theme"
import { FIXED_PITCH_FAMILY } from "../runtime/faces"

/** Built-in VS Code–inspired dark palette (not Gruvbox). */
export const jemacsDarkTheme = defineTheme("jemacs-dark", {
  default: { fg: "#d4d4d4", bg: "#1e1e1e", family: FIXED_PITCH_FAMILY },
  keyword: { fg: "#569cd6", bold: true },
  string: { fg: "#ce9178" },
  comment: { fg: "#6a9955", italic: true },
  builtin: { fg: "#4ec9b0" },
  function: { fg: "#dcdcaa" },
  type: { fg: "#4ec9b0" },
  number: { fg: "#b5cea8" },
  constant: { fg: "#9cdcfe" },
  preprocessor: { fg: "#c586c0" },
  doc: { fg: "#6a9955" },
  variable: { fg: "#9cdcfe" },
  directory: { fg: "#4fc1ff", bold: true },
  region: { bg: "#3f4756" },
  // Emacs `highlight': the current completion row. Deliberately warmer and
  // brighter than `region', so a mark set inside a highlighted row still reads.
  highlight: { bg: "#04395e" },
  isearch: { bg: "#6a5f00", fg: "#ffffff" },
  lazyHighlight: { bg: "#3a3a5a" },
  modeLine: { fg: "#ffffff", bg: "#264f78", bold: true },
  // Emacs: `tab-bar' is grey, `tab-bar-tab' inherits it, and
  // `tab-bar-tab-inactive' adds `:inverse-video t'. Nothing here can invert a
  // single span, so the pair's colours are swapped by hand: the selected tab
  // gets the mode line's treatment and the others stay dim.
  "tab-bar": { fg: "#d4d4d4", bg: "#252526" },
  "tab-bar-tab": { fg: "#ffffff", bg: "#264f78", bold: true },
  "tab-bar-tab-inactive": { fg: "#9d9d9d", bg: "#252526" },
  modeLineInactive: { fg: "#9d9d9d", bg: "#252526" },
  minibuffer: { fg: "#ffffff", bg: "#3a3a3a" },
  minibufferPrompt: { fg: "#4ec9b0", bold: true },
  title: { fg: "#cccccc", bg: "#1e1e1e" },
  warning: { fg: "#ffea7f", underline: true },
  success: { fg: "#89d185", bold: true },
  // Underline only — must layer over font-lock fg, not repaint it (t-1f96245b).
  error: { underline: true },
  lineNumber: { fg: "#6e7681", bg: "#161b22", italic: true },
  lineNumberCurrent: { fg: "#d4d4d4", bg: "#161b22", italic: true },
  helpLink: { fg: "#4fc1ff", underline: true },
  diffHeader: { fg: "#9cdcfe" },
  diffFileHeader: { fg: "#dcdcaa", bold: true },
  diffIndex: { fg: "#4fc1ff" },
  diffHunkHeader: { fg: "#c586c0", bold: true },
  diffRemoved: { fg: "#f48771" },
  diffAdded: { fg: "#b5cea8" },
  diffChanged: { fg: "#dcdcaa" },
  diffContext: { fg: "#9d9d9d" },
  diffFunction: { fg: "#4ec9b0" },
  diffNonexistent: { fg: "#808080", italic: true },
  diffRefineChanged: { bg: "#5f5a1f" },
  diffRefineRemoved: { bg: "#5f2424" },
  diffRefineAdded: { bg: "#245f2a" },
}, "Face colors inspired by the default VS Code dark palette.")
