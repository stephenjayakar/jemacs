import type { Editor } from "../src/kernel/editor"
import { createPluginContext, type PluginContext } from "../src/runtime/plugin-context"
import { defineTheme } from "../src/display/theme"
import { registerTheme } from "../src/themes"

/** Modus Vivendi palette, copied from `modus-vivendi-theme.el` (Emacs 30). */
export const modusVivendiPalette = {
  bgMain: "#000000",
  bgDim: "#1e1e1e",
  fgMain: "#ffffff",
  fgDim: "#989898",
  fgAlt: "#c6daff",
  bgActive: "#535353",
  bgInactive: "#303030",
  red: "#ff5f59",
  redCooler: "#ff7f9f",
  green: "#44bc44",
  yellow: "#d0bc00",
  yellowWarmer: "#fec43f",
  blue: "#2fafff",
  blueWarmer: "#79a8ff",
  blueCooler: "#00bcff",
  magenta: "#feacd0",
  magentaWarmer: "#f78fe7",
  magentaCooler: "#b6a0ff",
  magentaFaint: "#caa6df",
  cyan: "#00d3d0",
  cyanCooler: "#6ae4b9",
  cyanFaint: "#9ac8e0",
  yellowFaint: "#d2b580",
  bgRegion: "#5a5a5a",
  fgRegion: "#ffffff",
  bgSearchCurrent: "#7a6100",
  bgSearchLazy: "#2266ae",
  bgModeLineActive: "#505050",
  fgModeLineActive: "#ffffff",
  bgModeLineInactive: "#2d2d2d",
  fgModeLineInactive: "#969696",
  bgAdded: "#00381f",
  fgAdded: "#a0e0a0",
  bgChanged: "#363300",
  fgChanged: "#efef80",
  bgRemoved: "#4f1119",
  fgRemoved: "#ffbfbf",
  bgAddedRefine: "#034f2f",
  bgChangedRefine: "#4a4a00",
  bgRemovedRefine: "#781a1f",
  bgHoverSecondary: "#654a39",
} as const

const p = modusVivendiPalette

/**
 * Modus Vivendi — matches `custom-enabled-themes '(modus-vivendi)` in ~/.emacs.d.
 * Face mapping follows `modus-themes.el` code/UI mappings (keyword →
 * magenta-cooler, string → blue-warmer, variable → cyan, etc.).
 */
export const modusVivendiTheme = defineTheme("modus-vivendi", {
  default: { fg: p.fgMain, bg: p.bgMain },
  keyword: { fg: p.magentaCooler, bold: true },
  string: { fg: p.blueWarmer },
  comment: { fg: p.fgDim, italic: true },
  builtin: { fg: p.magentaWarmer, bold: true },
  function: { fg: p.magenta },
  type: { fg: p.cyanCooler, bold: true },
  number: { fg: p.blueCooler },
  constant: { fg: p.blueCooler },
  preprocessor: { fg: p.redCooler },
  doc: { fg: p.cyanFaint, italic: true },
  variable: { fg: p.cyan },
  directory: { fg: p.blueCooler },
  region: { fg: p.fgRegion, bg: p.bgRegion },
  highlight: { fg: p.fgMain, bg: p.bgHoverSecondary },
  isearch: { fg: p.fgMain, bg: p.bgSearchCurrent },
  lazyHighlight: { fg: p.fgMain, bg: p.bgSearchLazy },
  modeLine: { fg: p.fgModeLineActive, bg: p.bgModeLineActive },
  modeLineInactive: { fg: p.fgModeLineInactive, bg: p.bgModeLineInactive },
  minibuffer: { fg: p.fgMain, bg: p.bgMain },
  minibufferPrompt: { fg: p.cyanCooler, bold: true },
  title: { fg: p.fgMain, bg: p.bgDim },
  warning: { fg: p.yellowWarmer, bold: true },
  success: { fg: p.cyanCooler, bold: true },
  // Underline only — must layer over font-lock fg, not repaint it (t-1f96245b).
  error: { underline: true },
  lineNumber: { fg: p.fgDim, bg: p.bgDim },
  lineNumberCurrent: { fg: p.fgMain, bg: p.bgActive, bold: true },
  helpLink: { fg: p.blueWarmer, underline: true },
  diffHeader: { fg: p.fgMain },
  diffFileHeader: { fg: p.blueCooler, bold: true },
  diffIndex: { fg: p.fgDim, italic: true },
  diffHunkHeader: { fg: p.fgMain, bg: p.bgInactive, bold: true },
  diffRemoved: { fg: p.fgRemoved, bg: p.bgRemoved },
  diffAdded: { fg: p.fgAdded, bg: p.bgAdded },
  diffChanged: { fg: p.fgChanged, bg: p.bgChanged },
  diffContext: { fg: p.fgMain },
  diffFunction: { fg: p.fgMain, bg: p.bgInactive },
  diffNonexistent: { fg: p.fgDim, bold: true },
  diffRefineChanged: { bg: p.bgChangedRefine },
  diffRefineRemoved: { bg: p.bgRemovedRefine },
  diffRefineAdded: { bg: p.bgAddedRefine },
  "magit-section-highlight": { bg: p.bgDim },
  "magit-section-heading": { fg: p.fgMain, bold: true },
  "magit-section-secondary-heading": { fg: p.fgAlt, bold: true },
  "magit-section-heading-selection": { bg: p.bgHoverSecondary, bold: true },
  "magit-section-child-count": { fg: p.fgDim },
  "magit-left-margin": { fg: p.fgDim },
}, `Elegant, highly legible theme with a black background.
Conforms with the highest legibility standard for color contrast
between background and foreground in any given piece of text,
which corresponds to a minimum contrast in relative luminance of
7:1 (WCAG AAA standard).`)

export function install(_editor: Editor, _ctx: PluginContext = createPluginContext(_editor)): void {
  registerTheme(modusVivendiTheme)
}
