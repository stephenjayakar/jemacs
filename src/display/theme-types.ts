import type { FaceName } from "../kernel/extension-points"

/** Emacs `:underline (:color C :style S :position P)`. */
export type FaceUnderline = { color: string; style: string; position: unknown }

/** Emacs `:box (WIDTH COLOR STYLE)`, where WIDTH is `(vertical . horizontal)`. */
export type FaceBox = { width: [number, number]; color: string | null; style: string | null }

/**
 * A face's attributes.
 *
 * The first group is what the display layer renders. The rest are the
 * remaining `custom-face-attributes` entries: jemacs has no way to draw them
 * on a terminal, but Customize still edits them and the custom file still
 * round-trips them, so a config written against Emacs keeps its meaning.
 */
export type FaceStyle = {
  fg?: string
  bg?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  family?: string
  /** Absolute height in 1/10-point units (Emacs :height 140 → 14pt). */
  height?: number
  /** Relative height multiplier (face-remap semantics). */
  heightScale?: number
  inherit?: FaceName[]

  // --- edited by Customize, inert in the display layer ---------------------
  /** `:foundry`. */
  foundry?: string
  /** `:width`, e.g. `condensed`. */
  width?: string
  /** `:weight` when it is finer-grained than the `bold` flag, e.g. `semi-bold`. */
  weight?: string
  /** `:slant` when it is finer-grained than the `italic` flag, e.g. `oblique`. */
  slant?: string
  /** `:underline`'s full form; `underline` stays the boolean the display uses. */
  underlineSpec?: FaceUnderline
  /** `:overline`: false, true, or a colour. */
  overline?: boolean | string
  /** `:strike-through`: false, true, or a colour. */
  strikeThrough?: boolean | string
  /** `:box`. */
  box?: FaceBox
  /** `:inverse-video`. */
  inverseVideo?: boolean
  /** `:distant-foreground`. */
  distantForeground?: string
  /** `:stipple`: a bitmap file name. */
  stipple?: string
  /** `:extend`. */
  extend?: boolean
}

export type Theme = {
  name: string
  faces: Partial<Record<FaceName, FaceStyle>>
  /** `deftheme` docstring: the summary line shown by `customize-themes`. */
  doc?: string
}

export function defineTheme(name: string, faces: Partial<Record<FaceName, FaceStyle>>, doc?: string): Theme {
  return doc == null ? { name, faces } : { name, faces, doc }
}

export function faceStyleHasVisual(style?: FaceStyle): boolean {
  if (!style) return false
  return Boolean(
    style.fg || style.bg || style.bold || style.italic || style.underline
      || style.family || style.height != null || style.heightScale != null,
  )
}
