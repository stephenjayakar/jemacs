import type { BufferModel } from "../kernel/buffer"
import type { FaceName } from "../modes/mode"
import type { FaceStyle, Theme } from "../display/theme-types"
import { ensureCustomGroup } from "./custom"
import { registerCatalogEntry } from "./definitions"
import { captureCallerSource } from "./source"
import type { SourceLocation } from "./source"

/** Any face attribute Customize can set, `:inherit` included. The display
 *  layer only reads a few of them; the rest round-trip through Customize and
 *  the custom file so an Emacs config keeps its meaning. */
export type FaceAttribute = keyof FaceStyle

export type CustomFace = {
  name: string
  spec: FaceStyle
  doc?: string
  group?: string
  source?: SourceLocation
  baselineSpec: FaceStyle
  savedSpec?: FaceStyle
  customized: boolean
  /** Emacs `face-comment` / `saved-face-comment`. */
  comment?: string
  savedComment?: string
}

const faces = new Map<string, CustomFace>()
const customOverrides = new Map<string, FaceStyle>()
export const FACE_REMAP_KEY = "jemacs-face-remap"

/** Font stacks for the Emacs `variable-pitch` / `fixed-pitch` base faces.
 *  Prose modes remap `default` → variable-pitch and keep code spans on
 *  fixed-pitch so monospace alignment survives a proportional body. */
// Bundled webfont first (served by WebHost at /fonts/), then system stacks,
// then generic — so a missing font file degrades to "different mono", not serif.
export const VARIABLE_PITCH_FAMILY = '"JemacsSans", system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif'
export const FIXED_PITCH_FAMILY = '"JemacsMono", ui-monospace, "Fira Code", "Cascadia Code", Menlo, Consolas, monospace'

export function mergeFaceStyles(base: FaceStyle | undefined, overlay: FaceStyle | undefined): FaceStyle | undefined {
  if (!overlay) return base
  if (!base) return { ...overlay }
  const merged: FaceStyle = { ...base, ...overlay }
  if (overlay.inherit) merged.inherit = overlay.inherit
  return merged
}

/** `custom-set-faces`: install saved face specs read back from the custom file. */
export function customSetFaces(...specs: Array<[string, FaceStyle, string?]>): void {
  for (const [name, spec, comment] of specs) {
    if (!faces.has(name)) defface(name, {})
    const face = faces.get(name)!
    customOverrides.set(name, { ...spec })
    face.spec = mergeFaceStyles(face.baselineSpec, spec) ?? {}
    face.savedSpec = { ...spec }
    face.customized = true
    if (comment !== undefined) {
      face.comment = comment
      face.savedComment = comment
    }
    registerCatalogEntry({ kind: "face", name, source: face.source, doc: face.doc })
  }
}

/** Face attributes the user has changed but not yet saved (Emacs `customized-face`). */
export function faceIsUnsaved(name: string): boolean {
  const face = faces.get(name)
  if (!face?.customized) return false
  if (!face.savedSpec) return true
  if (face.comment !== face.savedComment) return true
  return !faceSpecsEqual(customOverrides.get(name), face.savedSpec)
}

export function defface(name: string, spec: FaceStyle, doc?: string, group?: string): CustomFace {
  const source = captureCallerSource(3)
  ensureCustomGroup(group)
  const existing = faces.get(name)
  if (existing) {
    existing.spec = { ...spec }
    if (doc) existing.doc = doc
    if (group) existing.group = group
    if (source) existing.source = source
    if (!existing.customized) existing.baselineSpec = { ...spec }
    registerCatalogEntry({ kind: "face", name, source: existing.source, doc: existing.doc })
    return existing
  }
  const face: CustomFace = {
    name,
    spec: { ...spec },
    doc,
    group,
    source,
    baselineSpec: { ...spec },
    customized: false,
  }
  faces.set(name, face)
  registerCatalogEntry({ kind: "face", name, source, doc })
  return face
}

export function getCustomFace(name: string): CustomFace | undefined {
  return faces.get(name)
}

export function listCustomFaces(): CustomFace[] {
  return [...faces.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function listKnownFaceNames(): string[] {
  const names = new Set<string>([
    "default", "variable-pitch", "fixed-pitch",
    "keyword", "string", "comment", "builtin", "function", "type",
    "number", "constant", "preprocessor", "doc", "variable",
    "directory", "region", "highlight", "isearch", "lazyHighlight",
    "modeLine", "modeLineInactive", "minibuffer", "minibufferPrompt", "title",
    "warning", "error", "lineNumber", "lineNumberCurrent",
    "diffHeader", "diffFileHeader", "diffIndex", "diffHunkHeader",
    "diffRemoved", "diffAdded", "diffChanged", "diffContext",
    "diffFunction", "diffNonexistent",
    "diffRefineChanged", "diffRefineRemoved", "diffRefineAdded",
  ])
  for (const face of faces.keys()) names.add(face)
  return [...names].sort()
}

export function getFaceRegistrySpec(name: string): FaceStyle | undefined {
  return faces.get(name)?.spec
}

// CSS generic-family keywords — if the last entry in a font stack is one of
// these the browser already has a guaranteed fallback.
const GENERIC_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui",
  "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "math", "emoji", "fangsong",
])

function hasGenericFamilySuffix(family: string): boolean {
  const last = family.split(",").pop()?.trim().toLowerCase() ?? ""
  return GENERIC_FAMILIES.has(last)
}

const warnedFamilyFallback = new Set<string>()

function ensureGenericFamilyFallback(faceName: string, family: string): string {
  if (hasGenericFamilySuffix(family)) return family
  const fallback = faceName === "variable-pitch" ? "sans-serif" : "monospace"
  if (!warnedFamilyFallback.has(faceName)) {
    warnedFamilyFallback.add(faceName)
    console.warn(
      `[jemacs] face '${faceName}': family "${family}" has no generic fallback; appending ${fallback}`,
    )
  }
  return `${family}, ${fallback}`
}

export function setFaceAttribute(name: string, attribute: FaceAttribute, value: unknown): void {
  if (!faces.has(name)) defface(name, {})
  if (attribute === "family" && typeof value === "string") {
    value = ensureGenericFamilyFallback(name, value)
  }
  const override = customOverrides.get(name) ?? {}
  const next = { ...override, [attribute]: value } as FaceStyle
  customOverrides.set(name, next)
  const face = faces.get(name)!
  face.spec = mergeFaceStyles(face.baselineSpec, next) ?? {}
  face.customized = true
  registerCatalogEntry({ kind: "face", name, source: face.source, doc: face.doc })
}

/** Emacs `face-comment`: free-text note attached to a customized face. */
export function setFaceComment(name: string, comment: string | undefined): void {
  if (!faces.has(name)) defface(name, {})
  const face = faces.get(name)!
  face.comment = comment || undefined
  face.customized = true
}

export function getFaceComment(name: string): string | undefined {
  return faces.get(name)?.comment
}

/** Unchecking an attribute checkbox drops that attribute. An attribute that
 *  came from the face's own `defface` spec is masked with an explicit
 *  `undefined` override, which is how the merged spec loses it — the same
 *  effect as removing the attribute from the checklist in Emacs. */
export function unsetFaceAttribute(name: string, attribute: FaceAttribute): boolean {
  const face = faces.get(name)
  if (!face) return false
  const override = customOverrides.get(name) ?? {}
  const inOverride = attribute in override && override[attribute] !== undefined
  const inBaseline = face.baselineSpec[attribute] != null
  if (!inOverride && !inBaseline) return false
  const next: FaceStyle = { ...override }
  if (inBaseline) next[attribute] = undefined
  else delete next[attribute]
  if (Object.keys(next).length) customOverrides.set(name, next)
  else customOverrides.delete(name)
  face.spec = mergeFaceStyles(face.baselineSpec, customOverrides.get(name)) ?? { ...face.baselineSpec }
  face.customized = customOverrides.has(name)
  registerCatalogEntry({ kind: "face", name, source: face.source, doc: face.doc })
  return true
}

export function getCustomFaceOverrides(): Partial<Record<string, FaceStyle>> {
  const out: Partial<Record<string, FaceStyle>> = {}
  for (const [name, style] of customOverrides) out[name] = { ...style }
  return out
}

export function getCustomizedFaceOverrides(): Array<{ name: string; style: FaceStyle }> {
  return [...customOverrides.entries()]
    .filter(([name]) => faces.get(name)?.customized)
    .map(([name, style]) => ({ name, style: { ...style } }))
}

export function saveFace(name: string, spec?: FaceStyle): void {
  const face = faces.get(name)
  if (!face) throw new Error(`Unknown face: ${name}`)
  if (spec) customOverrides.set(name, { ...spec })
  const override = customOverrides.get(name)
  if (!override) return
  face.savedSpec = { ...override }
  face.savedComment = face.comment
  face.customized = true
  registerCatalogEntry({ kind: "face", name, source: face.source, doc: face.doc })
}

export function resetFace(name: string): boolean {
  const face = faces.get(name)
  if (!face) return false
  customOverrides.delete(name)
  face.spec = { ...face.baselineSpec }
  face.customized = false
  face.savedSpec = undefined
  face.comment = undefined
  face.savedComment = undefined
  registerCatalogEntry({ kind: "face", name, source: face.source, doc: face.doc })
  return true
}

export function resetFaceToSaved(name: string): boolean {
  const face = faces.get(name)
  if (!face?.savedSpec) return false
  customOverrides.set(name, { ...face.savedSpec })
  face.spec = mergeFaceStyles(face.baselineSpec, face.savedSpec) ?? {}
  face.comment = face.savedComment
  face.customized = true
  registerCatalogEntry({ kind: "face", name, source: face.source, doc: face.doc })
  return true
}

export function faceCustomState(name: string): "STANDARD" | "SET" | "SAVED" | "CHANGED" {
  const face = faces.get(name)
  if (!face) return "STANDARD"
  if (!face.customized) return "STANDARD"
  if (face.savedSpec && faceSpecsEqual(customOverrides.get(name), face.savedSpec)) return "SAVED"
  if (face.savedSpec) return "SET"
  return "SET"
}

function faceSpecsEqual(a?: FaceStyle, b?: FaceStyle): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof FaceStyle>
  for (const key of keys) {
    if (key === "inherit") continue
    if (!Object.is(a[key], b[key])) return false
  }
  return true
}

export function composeTheme(base: Theme, overrides: Partial<Record<string, FaceStyle>> = getCustomFaceOverrides()): Theme {
  const facesOut: Theme["faces"] = { ...base.faces }
  for (const [name, style] of Object.entries(overrides)) {
    const key = name as FaceName
    facesOut[key] = mergeFaceStyles(facesOut[key], style)
  }
  return { name: base.name, faces: facesOut }
}

export function faceRemapAddRelative(buffer: BufferModel, face: string, attrs: FaceStyle): void {
  const remaps = getBufferFaceRemaps(buffer)
  remaps.set(face, mergeFaceStyles(remaps.get(face), attrs) ?? attrs)
  buffer.locals.set(FACE_REMAP_KEY, remaps)
}

export function faceRemapReset(buffer: BufferModel, face?: string): void {
  if (!face) {
    buffer.locals.delete(FACE_REMAP_KEY)
    return
  }
  const remaps = getBufferFaceRemaps(buffer)
  remaps.delete(face)
  if (!remaps.size) buffer.locals.delete(FACE_REMAP_KEY)
  else buffer.locals.set(FACE_REMAP_KEY, remaps)
}

function getBufferFaceRemaps(buffer: BufferModel): Map<string, FaceStyle> {
  const existing = buffer.locals.get(FACE_REMAP_KEY) as Map<string, FaceStyle> | undefined
  return existing ?? new Map()
}

export function getBufferFaceRemap(buffer: BufferModel, face: string): FaceStyle | undefined {
  return getBufferFaceRemaps(buffer).get(face)
}

export function resolveFace(face: FaceName, theme: Theme, buffer?: BufferModel): FaceStyle | undefined {
  const resolved = resolveFaceFromTheme(face, theme, new Set(), buffer)
  const remap = buffer ? getBufferFaceRemap(buffer, face) : undefined
  if (!remap) return resolved
  return applyFaceRemap(resolved, remap)
}

function resolveFaceFromTheme(
  face: FaceName,
  theme: Theme,
  visited: Set<FaceName>,
  buffer?: BufferModel,
): FaceStyle | undefined {
  if (visited.has(face)) return theme.faces.default
  visited.add(face)
  const spec = theme.faces[face]
  const registry = getFaceRegistrySpec(face)

  // A theme's `:inherit` wins over the one the face was defined with, matching
  // Emacs: the theme is the later, more specific customization. Honouring the
  // registry's `inherit` at all is what makes `defface(x, { inherit: ["comment"] })`
  // actually pick up comment's colour -- it used to be merged in as an inert
  // key, so such a face resolved to no foreground and rendered as plain default.
  const inherit = spec?.inherit?.length ? spec.inherit : registry?.inherit

  let base: FaceStyle | undefined
  if (inherit?.length) {
    for (const parent of inherit) {
      base = mergeFaceStyles(base, resolveFaceFromTheme(parent, theme, visited, buffer))
    }
  } else if (face !== "default") {
    base = inheritFontFrom(resolvedDefaultFace(theme, buffer, visited))
  }

  base = mergeFaceStyles(base, registry ? omitInherit(registry) : undefined)
  base = mergeFaceStyles(base, spec ? omitInherit(spec) : undefined)
  return base
}

/** Theme default plus buffer-local `default` face-remap (used when inheriting font metrics). */
function resolvedDefaultFace(
  theme: Theme,
  buffer: BufferModel | undefined,
  visited: Set<FaceName>,
): FaceStyle | undefined {
  const fromTheme = resolveFaceFromTheme("default", theme, visited, buffer)
  if (!buffer) return fromTheme
  const remap = getBufferFaceRemap(buffer, "default")
  if (!remap) return fromTheme
  return applyFaceRemap(fromTheme, remap)
}

function inheritFontFrom(style?: FaceStyle): FaceStyle | undefined {
  if (!style) return undefined
  const inherited: FaceStyle = {}
  if (style.family) inherited.family = style.family
  if (style.height != null) inherited.height = style.height
  return Object.keys(inherited).length ? inherited : undefined
}

function omitInherit(style: FaceStyle): FaceStyle {
  const { inherit: _inherit, ...rest } = style
  return rest
}

function applyFaceRemap(base: FaceStyle | undefined, remap: FaceStyle): FaceStyle | undefined {
  const { height, heightScale, ...rest } = remap
  let result = mergeFaceStyles(base, rest)
  if (height != null) result = { ...result, height }
  if (heightScale != null) {
    const currentHeight = result?.height ?? base?.height
    if (currentHeight != null) result = { ...result, height: currentHeight * heightScale, heightScale: undefined }
    else result = { ...result, heightScale }
  }
  return result
}

export function resolveThemeFace(theme: Theme, face: FaceName, buffer?: BufferModel): FaceStyle | undefined {
  return resolveFace(face, theme, buffer)
}

defface("variable-pitch", { family: VARIABLE_PITCH_FAMILY }, "The basic variable-pitch face.", "basic-faces")
defface("fixed-pitch", { family: FIXED_PITCH_FAMILY }, "The basic fixed-pitch face.", "basic-faces")
