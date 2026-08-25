/**
 * `custom-face-attributes` (cus-face.el): the widget for each face attribute,
 * in the order `customize-face` prints them.
 *
 * Each entry pairs a `FaceStyle` key with the `CustomType` its row is drawn
 * with, plus the conversion both ways between the stored value and the value
 * the widget edits — cus-face.el's "filter to make value suitable for
 * customize" and "filter to make customized-value suitable for storing".
 */
import type { FaceBox, FaceStyle, FaceUnderline } from "../display/theme-types"
import type { CustomType } from "../runtime/custom"
import { FloatValue, isFloatValue } from "./custom-widgets"

export type FaceAttributeKey = keyof FaceStyle

export type FaceAttributeSpec = {
  key: FaceAttributeKey
  /** The `:tag` cus-face.el gives the row. */
  tag: string
  type: CustomType
  /** Stored value -> the value the widget shows. */
  toWidget?: (value: unknown) => unknown
  /** Widget value -> the value stored on the face. */
  fromWidget?: (value: unknown) => unknown
  /** Value shown when the attribute is switched on with nothing set yet. */
  defaultValue: unknown
}

/** cus-face.el's `color` widget: a field, a `[ Choose ]` button, and a swatch.
 *  It defaults to the frame's foreground, which on a dark terminal is black. */
const color: CustomType = "color"

/** The value an unset colour row shows. Emacs seeds it with the frame's
 *  foreground, which for the default frame is black. */
const DEFAULT_COLOR = "black"

/** `(choice (const :tag "Off" nil) (const :tag "On" t) (color :tag "Colored"))` */
const onOffColor: CustomType = {
  kind: "choice",
  options: [
    { const: false, tag: "Off" },
    { const: true, tag: "On" },
    { type: color, tag: "Colored" },
  ],
}

const onOff: CustomType = {
  kind: "choice",
  options: [{ const: false, tag: "Off" }, { const: true, tag: "On" }],
}

/** `:underline`'s `On` arm: `(list (choice Color) (choice Style) (choice Position))`. */
const underlineOn: CustomType = {
  kind: "list",
  items: [
    {
      kind: "choice",
      tag: "Color",
      options: [{ const: "foreground-color", tag: "Foreground Color" }, { type: color }],
    },
    {
      kind: "choice",
      tag: "Style",
      options: [
        { const: "line", tag: "Line" },
        { const: "double-line", tag: "Double line" },
        { const: "wave", tag: "Wave" },
        { const: "dots", tag: "Dots" },
        { const: "dashes", tag: "Dashes" },
      ],
    },
    {
      kind: "choice",
      tag: "Position",
      options: [
        { const: null, tag: "At Default Position" },
        { const: true, tag: "At Bottom Of Text" },
        { type: "integer", tag: "Pixels Above Bottom Of Text" },
      ],
    },
  ],
}

/** `:box`'s `Box` arm: `(list (cons Width) (choice Color) (choice Style))`. */
const boxOn: CustomType = {
  kind: "list",
  items: [
    { kind: "list", tag: "Width", items: ["integer", "integer"] },
    { kind: "choice", tag: "Color", options: [{ const: null, tag: "*" }, { type: color }] },
    {
      kind: "choice",
      tag: "Style",
      options: [
        { const: "released-button", tag: "Raised" },
        { const: "pressed-button", tag: "Sunken" },
        { const: "flat-button", tag: "Flat" },
        { const: null, tag: "None" },
      ],
    },
  ],
}

function widthChoice(tags: Array<[string, string]>): CustomType {
  return { kind: "choice", options: tags.map(([tag, value]) => ({ const: value, tag })) }
}

/** cus-face.el's `:weight` arm list, in its order. */
const WEIGHTS: Array<[string, string]> = [
  ["thin", "thin"], ["ultralight", "ultra-light"], ["ultra-light", "ultra-light"],
  ["extralight", "ultra-light"], ["extra-light", "ultra-light"], ["light", "light"],
  ["semilight", "semi-light"], ["semi-light", "semi-light"], ["demilight", "semi-light"],
  ["normal", "normal"], ["regular", "regular"], ["book", "normal"], ["medium", "medium"],
  ["semibold", "semi-bold"], ["semi-bold", "semi-bold"], ["demibold", "semi-bold"],
  ["demi-bold", "semi-bold"], ["bold", "bold"], ["extrabold", "extra-bold"],
  ["extra-bold", "extra-bold"], ["ultrabold", "extra-bold"], ["ultra-bold", "extra-bold"],
  ["heavy", "heavy"], ["black", "heavy"], ["ultra-heavy", "ultra-heavy"],
  ["ultraheavy", "ultra-heavy"],
]

const WIDTHS: Array<[string, string]> = [
  ["compressed", "condensed"], ["condensed", "condensed"], ["demiexpanded", "semi-expanded"],
  ["expanded", "expanded"], ["extracondensed", "extra-condensed"],
  ["extra-condensed", "extra-condensed"], ["extraexpanded", "extra-expanded"],
  ["extra-expanded", "extra-expanded"], ["narrow", "condensed"], ["normal", "normal"],
  ["medium", "normal"], ["regular", "normal"], ["semicondensed", "semi-condensed"],
  ["demicondensed", "semi-condensed"], ["semi-condensed", "semi-condensed"],
  ["semiexpanded", "semi-expanded"], ["ultracondensed", "ultra-condensed"],
  ["ultra-condensed", "ultra-condensed"], ["ultraexpanded", "ultra-expanded"],
  ["ultra-expanded", "ultra-expanded"], ["wide", "extra-expanded"],
]

const SLANTS: Array<[string, string]> = [
  ["italic", "italic"], ["oblique", "oblique"], ["normal", "normal"], ["roman", "roman"],
]

/**
 * `:height` is `(choice (integer "Font size in 1/10 pt") (number "Scale" 1.0))`.
 * jemacs splits the two arms into separate `FaceStyle` keys (`height` is
 * absolute, `heightScale` relative), so the widget is keyed on `height` and
 * the conversion picks the arm.
 */
const heightType: CustomType = {
  kind: "choice",
  options: [
    { type: "integer", tag: "Font size in 1/10 pt" },
    { type: "number", tag: "Scale" },
  ],
}

/** The rows `customize-face` draws, in cus-face.el's order. */
export const FACE_ATTRIBUTE_SPECS: FaceAttributeSpec[] = [
  { key: "family", tag: "Font Family", type: "string", defaultValue: "" },
  { key: "foundry", tag: "Font Foundry", type: "string", defaultValue: "" },
  { key: "width", tag: "Width", type: widthChoice(WIDTHS), defaultValue: "normal" },
  // An unset `:height` shows the `Scale` arm at 1.0 (cus-face.el's `(number :tag "Scale" 1.0)`).
  { key: "height", tag: "Height", type: heightType, defaultValue: new FloatValue(1.0) },
  { key: "weight", tag: "Weight", type: widthChoice(WEIGHTS), defaultValue: "normal" },
  { key: "slant", tag: "Slant", type: widthChoice(SLANTS), defaultValue: "normal" },
  {
    key: "underline",
    tag: "Underline",
    type: { kind: "choice", options: [{ const: false, tag: "Off" }, { type: underlineOn, tag: "On" }] },
    defaultValue: false,
  },
  { key: "overline", tag: "Overline", type: onOffColor, defaultValue: false },
  { key: "strikeThrough", tag: "Strike-through", type: onOffColor, defaultValue: false },
  {
    key: "box",
    tag: "Box around text",
    type: { kind: "choice", options: [{ const: false, tag: "Off" }, { type: boxOn, tag: "Box" }] },
    defaultValue: false,
  },
  { key: "inverseVideo", tag: "Inverse-video", type: onOff, defaultValue: false },
  { key: "fg", tag: "Foreground", type: color, defaultValue: DEFAULT_COLOR },
  { key: "distantForeground", tag: "Distant Foreground", type: color, defaultValue: DEFAULT_COLOR },
  { key: "bg", tag: "Background", type: color, defaultValue: DEFAULT_COLOR },
  {
    key: "stipple",
    tag: "Stipple",
    type: { kind: "choice", options: [{ const: null, tag: "None" }, { type: "file", tag: "File" }] },
    defaultValue: null,
  },
  { key: "extend", tag: "Extend", type: onOff, defaultValue: false },
  {
    key: "inherit",
    tag: "Inherit",
    type: { kind: "repeat", item: "face", tag: "Inherit" },
    defaultValue: [],
  },
]

/** Rows rendered as a plain `Color: [ Choose ]  (sample)` field. */
export const FACE_COLOR_KEYS = new Set<FaceAttributeKey>(["fg", "bg", "distantForeground"])

export function faceAttributeSpec(key: FaceAttributeKey): FaceAttributeSpec | undefined {
  return FACE_ATTRIBUTE_SPECS.find(spec => spec.key === key)
}

/**
 * The value a face attribute's widget shows.
 *
 * Three keys need a conversion, because the display layer stores them in a
 * shape of its own: `height` merges the absolute and scaled forms, `underline`
 * carries a boolean alongside the full spec, and `weight`/`slant` mirror the
 * `bold`/`italic` flags.
 */
export function faceAttributeToWidget(style: FaceStyle, key: FaceAttributeKey): unknown {
  switch (key) {
    case "height":
      // The absolute form is an integer (the `Font size in 1/10 pt` arm); the
      // scaled form is Emacs's float (the `Scale` arm).
      return style.height ?? (style.heightScale == null ? undefined : new FloatValue(style.heightScale))
    case "underline":
      // cus-face.el's "filter to make value suitable for customize" turns the
      // shorthand `t` into the full `(:color foreground-color :style line
      // :position nil)`, so a plain boolean shows the `On` arm's rows.
      if (style.underlineSpec) {
        return [style.underlineSpec.color, style.underlineSpec.style, style.underlineSpec.position]
      }
      if (style.underline) return ["foreground-color", "line", null]
      return style.underline ?? false
    case "weight":
      return style.weight ?? (style.bold ? "bold" : undefined)
    case "slant":
      return style.slant ?? (style.italic ? "italic" : undefined)
    case "box":
      return style.box ? [style.box.width, style.box.color, style.box.style] : (style.box ?? false)
    default:
      return style[key]
  }
}

/** Is the attribute set on this face, i.e. does its checkbox read `[X]`? */
export function faceAttributeIsSet(style: FaceStyle, key: FaceAttributeKey): boolean {
  switch (key) {
    case "height": return style.height != null || style.heightScale != null
    case "underline": return style.underlineSpec != null || style.underline != null
    case "weight": return style.weight != null || style.bold != null
    case "slant": return style.slant != null || style.italic != null
    case "inherit": return (style.inherit?.length ?? 0) > 0
    default: return style[key] !== undefined
  }
}

/** Fold a widget value back into the `FaceStyle` keys it came from. */
export function faceAttributeFromWidget(key: FaceAttributeKey, value: unknown): Partial<FaceStyle> {
  switch (key) {
    case "height": {
      // An integer is Emacs's absolute 1/10-pt height; a float is a scale.
      if (isFloatValue(value)) return { heightScale: value.value, height: undefined }
      return typeof value === "number"
        ? { height: value, heightScale: undefined }
        : { height: undefined, heightScale: undefined }
    }
    case "underline": {
      if (!Array.isArray(value)) {
        return { underline: Boolean(value), underlineSpec: undefined }
      }
      const [c, style, position] = value as [string, string, unknown]
      return {
        underline: true,
        underlineSpec: { color: c ?? "foreground-color", style: style ?? "line", position: position ?? null } as FaceUnderline,
      }
    }
    case "weight":
      // Keep the display layer's boolean in step with the finer-grained value.
      return { weight: value as string, bold: typeof value === "string" && /bold|heavy|black/.test(value) }
    case "slant":
      return { slant: value as string, italic: value === "italic" || value === "oblique" }
    case "box": {
      if (!Array.isArray(value)) return { box: undefined }
      const [width, c, style] = value as [[number, number], string | null, string | null]
      return { box: { width: width ?? [1, 1], color: c ?? null, style: style ?? null } as FaceBox }
    }
    case "inherit":
      return { inherit: Array.isArray(value) ? (value as FaceStyle["inherit"]) : [] }
    default:
      return { [key]: value } as Partial<FaceStyle>
  }
}

/** The `FaceStyle` keys an attribute row owns, for unsetting its checkbox. */
export function faceAttributeKeys(key: FaceAttributeKey): FaceAttributeKey[] {
  switch (key) {
    case "height": return ["height", "heightScale"]
    case "underline": return ["underline", "underlineSpec"]
    case "weight": return ["weight", "bold"]
    case "slant": return ["slant", "italic"]
    default: return [key]
  }
}
