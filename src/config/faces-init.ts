import { defface } from "../runtime/faces"
import { jemacsDarkTheme } from "../themes/jemacs-dark"

/** Register baseline face specs from the default theme (Emacs `defface` analogue). */
export function installDefaultFaces(): void {
  for (const [name, spec] of Object.entries(jemacsDarkTheme.faces)) {
    if (spec) defface(name, spec)
  }
  installCustomFaces()
}

/**
 * cus-edit.el's own faces, as `defface` declares them for a colour terminal.
 * Without these every Custom buffer renders in one flat colour, which is the
 * most visible way it can differ from Emacs even when the text matches.
 */
function installCustomFaces(): void {
  // `(((class color) (min-colors 88) (background dark)) :foreground "cyan1" :underline t)`
  defface("custom-link", { fg: "#00ffff", underline: true },
    "Face for links in customization buffers.", "custom-faces")
  // `:height 0.8 :inherit link`
  defface("custom-visibility", { inherit: ["custom-link"], heightScale: 0.8 },
    "Face for the `Hide'/`Show' visibility buttons.", "custom-faces")
  // A terminal has no relief, so Emacs falls back to `:inherit underline`.
  defface("custom-button", { underline: true },
    "Face for custom buffer buttons if `custom-raised-buttons' is non-nil.", "custom-faces")
  defface("custom-button-unraised", { underline: true },
    "Face for custom buffer buttons if `custom-raised-buttons' is nil.", "custom-faces")
  defface("custom-button-pressed", { inherit: ["custom-button"], bold: true },
    "Face for pressed custom buttons.", "custom-faces")
  // `(((type tty)) :background "yellow3" :foreground "black" :extend t)`
  defface("widget-field", { fg: "#000000", bg: "#cdcd00" },
    "Face for editable fields.", "custom-faces")
  // `shadow` dark: `:foreground "grey70"`. `widget-inactive` is `:inherit shadow`
  // and nothing more, so it must not be italicised.
  defface("shadow", { fg: "#b3b3b3" }, "Face for making text less prominent.", "basic-faces")
  defface("widget-inactive", { inherit: ["shadow"] },
    "Face for inactive widgets.", "custom-faces")

  // `(((class color) (background dark)) :foreground "light blue" :weight bold)`
  defface("custom-variable-tag", { fg: "#add8e6", bold: true },
    "Face used for unpushable variable tags.", "custom-faces")
  defface("custom-variable-obsolete", { inherit: ["custom-variable-tag"], fg: "#b3b3b3" },
    "Face used for obsolete variables.", "custom-faces")
  // `:inherit custom-variable-tag`
  defface("custom-face-tag", { inherit: ["custom-variable-tag"] },
    "Face used for face tags.", "custom-faces")
  // `(default :weight bold :height 1.2 :inherit variable-pitch)` plus
  // `(((class color) (background dark)) :foreground "light blue")`
  defface("custom-group-tag", { fg: "#add8e6", bold: true, heightScale: 1.2 },
    "Face used for group tags.", "custom-faces")
  // ...and `"pink"` for the nested variant.
  defface("custom-group-tag-1", { fg: "#ffc0cb", bold: true, heightScale: 1.2 },
    "Face used for low-level group tags.", "custom-faces")
  // `custom-group--draw-horizontal-line` propertizes its newline `(:underline t)`.
  defface("custom-group-rule", { underline: true },
    "Face for the horizontal rule around a group's members.", "custom-faces")
  defface("custom-group-subtitle", { bold: true },
    "Face for the \"Subgroups:\" subtitle in Custom buffers.", "custom-faces")
  // `(((class color) (background dark)) :foreground "lime green")`
  defface("custom-state", { fg: "#32cd32" },
    "Face used for State descriptions.", "custom-faces")
  // `((t nil))` — documentation carries the face but no attributes of its own.
  defface("custom-documentation", {},
    "Face used for documentation strings in customization buffers.", "custom-faces")
  // `(((type tty)) :background "yellow3" :foreground "black")`
  defface("custom-comment", { fg: "#000000", bg: "#cdcd00" },
    "Face used for comments on variables or faces.", "custom-faces")
  // `(((class color) (background dark)) :foreground "gray80")`
  defface("custom-comment-tag", { fg: "#cccccc" },
    "Face used for the comment tag.", "custom-faces")

  // The `custom-magic-alist` state faces, all `min-colors 88` colour variants.
  defface("custom-modified", { fg: "#ffffff", bg: "#0000ff" },
    "Face used when the customize item has been modified.", "custom-faces")
  defface("custom-set", { fg: "#0000ff", bg: "#ffffff" },
    "Face used when the customize item has been set.", "custom-faces")
  defface("custom-changed", { fg: "#ffffff", bg: "#0000ff" },
    "Face used when the customize item has been changed.", "custom-faces")
  defface("custom-saved", { underline: true },
    "Face used when the customize item has been saved.", "custom-faces")
  defface("custom-themed", { fg: "#ffffff", bg: "#0000ff" },
    "Face used when the customize item has been themed.", "custom-faces")
  defface("custom-rogue", { fg: "#ffc0cb", bg: "#000000" },
    "Face used when the customize item is not defined for customization.", "custom-faces")
  defface("custom-invalid", { fg: "#ffff00", bg: "#ff0000" },
    "Face used when the customize item is invalid.", "custom-faces")
}
