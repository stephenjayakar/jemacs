import type { FaceName } from "../kernel/extension-points"

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
}

export type Theme = {
  name: string
  faces: Partial<Record<FaceName, FaceStyle>>
}

export function defineTheme(name: string, faces: Partial<Record<FaceName, FaceStyle>>): Theme {
  return { name, faces }
}

export function faceStyleHasVisual(style?: FaceStyle): boolean {
  if (!style) return false
  return Boolean(
    style.fg || style.bg || style.bold || style.italic || style.underline
      || style.family || style.height != null || style.heightScale != null,
  )
}
