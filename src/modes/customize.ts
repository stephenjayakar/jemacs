import type { Editor } from "../kernel/editor"
import type { BufferModel } from "../kernel/buffer"
import { REVERT_BUFFER_FUNCTION_KEY } from "../kernel/buffer"
import { Keymap } from "../kernel/keymap"
import { addPointKeymapSource } from "../kernel/extension-points"
import { defineMode, getMode } from "./mode"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  customGroupChildren,
  customTypeLabel,
  defcustom,
  defgroup,
  getCustomGroup,
  getCustomVariable,
  getCustom,
  isCompositeType,
  getCustomIcon,
  listCustomGroups,
  listCustomIcons,
  resetCustomIcon,
  resetCustomIconToSaved,
  saveCustomIcon,
  setCustomIcon,
  listCustomVariables,
  resetCustom,
  resetCustomToSaved,
  saveCustom,
  setCustom,
  setCustomComment,
  setCustomValue,
  TOP_CUSTOM_GROUP,
  type CustomIconSpec,
  type CustomType,
  type CustomVariable,
} from "../runtime/custom"
import {
  chosenArm,
  choiceLabel,
  defaultValue,
  deepEqual,
  formatScalar,
  formatValue,
  getAtPath,
  parseValue,
  pathKey,
  setAtPath,
  typeAtPath,
  widgetIsMultiLine,
  widgetShowsInline,
  type ValuePath,
} from "./custom-widgets"
import { saveCustomFile } from "../config/load-custom"
import {
  FACE_ATTRIBUTE_SPECS,
  faceAttributeFromWidget,
  faceAttributeIsSet,
  faceAttributeKeys,
  faceAttributeToWidget,
  type FaceAttributeKey,
  type FaceAttributeSpec,
} from "./custom-face-attributes"
import { formatDirLocals, parseDirLocals, type DirlocalsSpec } from "./dir-locals"
import type { FaceStyle } from "../display/theme-types"
import {
  faceIsUnsaved,
  getCustomFace,
  getCustomizedFaceOverrides,
  getFaceComment,
  listKnownFaceNames,
  resetFace,
  resetFaceToSaved,
  resolveThemeFace,
  saveFace,
  setFaceAttribute,
  setFaceComment,
  unsetFaceAttribute,
} from "../runtime/faces"
import type { FaceName, TextSpan } from "./mode"
import {
  disableBuiltinTheme,
  getBuiltinTheme,
  isBuiltinThemeEnabled,
  listBuiltinThemeNames,
  listEnabledBuiltinThemes,
  listSavedBuiltinThemes,
  saveEnabledBuiltinThemes,
  themeSource,
  themeSummary,
} from "../themes"

export const CUSTOMIZE_VARIABLE_KEY = "jemacs-customize-variable"
export const CUSTOMIZE_THEME_KEY = "jemacs-customize-theme"
export const CUSTOMIZE_FACE_KEY = "jemacs-customize-face"
export const CUSTOMIZE_TITLE_KEY = "jemacs-customize-title"
/** Buffer-local `custom--invocation-options` plus the widget/field tables. */
const CUSTOM_SPEC_KEY = "jemacs-custom-spec"
const CUSTOM_WIDGETS_KEY = "jemacs-custom-widgets"
const CUSTOM_FIELDS_KEY = "jemacs-custom-fields"
/** Buffer-local font-lock spans: cus-edit.el propertizes each widget instead. */
const CUSTOM_SPANS_KEY = "jemacs-custom-spans"
/** Buffer-local state of the `*Customize Browser*` tree. */
const CUSTOM_BROWSE_KEY = "jemacs-custom-browse"
/** Buffer-local state of the `*Custom Theme*` (custom-new-theme-mode) buffer. */
const CUSTOM_NEW_THEME_KEY = "jemacs-custom-new-theme"
/** Buffer-local state of the `*Customize Dirlocals*` buffer. */
const CUSTOM_DIRLOCALS_KEY = "jemacs-custom-dirlocals"

/** `[X][ name] -- summary` rows written by `customize-themes` (cus-theme.el). */
const THEME_ROW_RE = /^\[([ X])\]\[ (.+?)\] --/
const THEME_ROW_RE_G = /^\[([ X])\]\[ (.+?)\] --/gm
const THEME_SAVE_BUTTON = "[ Save Theme Settings ]"
const THEME_MULTIPLE_LABEL = "Select more than one theme at a time"
const THEME_MIGRATE_BUTTON = "[here]"

/** Options the chooser itself writes; in Emacs these are `setq`/`custom-theme-save`
 *  state rather than entries in `(get 'user 'theme-settings)`. */
const CHOOSER_OWNED_OPTIONS = new Set(["custom-enabled-themes", "custom-theme-allow-multiple-selections"])

/** `(get 'user 'theme-settings)` beyond `custom-enabled-themes`: any option or
 *  face the user customized, which is what gates the chooser's Note block. */
function hasUserCustomizations(): boolean {
  if (getCustomizedFaceOverrides().length) return true
  return listCustomVariables().some(variable =>
    variable.customized && !CHOOSER_OWNED_OPTIONS.has(variable.name))
}

/** Column the subgroup doc strings start at. cus-edit.el writes `"\t\t    "`
 *  after the tag, which with Emacs's 8-column tab stops resolves to column 24
 *  for every tag shorter than 16 columns. A terminal pane has no tab stops of
 *  its own, so the renderer emits the resolved spaces instead. */
const GROUP_DOC_ALIGN_COL = 24

/** Of that padding, the last four columns are literal spaces in cus-edit.el's
 *  `"\t\t    "`, and they carry the doc string's face; the tabs do not. */
const GROUP_DOC_FACED_PAD = 4

/** Columns each nesting level of a value widget indents by. wid-edit.el
 *  advances `:indent` by the parent's tag width; for these widgets that is the
 *  12 columns of the shared `[INS] [DEL] ` row prefix. */
const WIDGET_INDENT = 12

/** Face attributes in the order `custom-face-attributes` lists them. */
/** Column an attribute row's nested widget rows indent to. cus-face.el gives
 *  `custom-face-edit` `:extra-offset 3`, which puts them under the tag. */
const FACE_ATTR_INDENT = 7

/** `custom-magic-alist` item descriptions, most significant first. */
const CUSTOM_MAGIC: Array<[CustomState, string, string]> = [
  ["modified", "EDITED, shown value does not take effect until you set or save it.",
    "something in this group has been edited but not set."],
  ["set", "SET for current session only.", "something in this group has been set but not saved."],
  ["changed", "CHANGED outside Customize.", "something in this group has been changed outside customize."],
  ["saved", "SAVED and set.", "something in this group has been set and saved."],
  ["themed", "THEMED.", "visible group members are set by enabled themes."],
  ["rogue", "NO CUSTOMIZATION DATA; not intended to be customized.",
    "something in this group is not prepared for customization."],
  ["standard", "STANDARD.", "visible group members are all at standard values."],
]

type CustomState = "hidden" | "modified" | "set" | "changed" | "saved" | "themed" | "rogue" | "standard"

/** One line item of a Custom buffer: `((SYMBOL WIDGET)...)` in cus-edit.el. */
type CustomEntry = {
  kind: "variable" | "face" | "group" | "icon"
  name: string
  /** Group members (`custom-group` widget children), created once and reused. */
  children?: CustomEntry[]
  /** Collapsed to the `Show Value NAME` one-liner. */
  hidden?: boolean
  /** `More`/`Hide` state of the multi-line documentation button. */
  docShown?: boolean
  /** Edited-but-not-applied value (widget `:shown-value`); undefined = pristine. */
  shown?: unknown
  /** Text typed into each editable field, keyed by `pathKey(path)`. */
  shownText?: Record<string, string>
  /** Per-attribute edits for a face widget. */
  /** Edited-but-not-applied attribute values, keyed by `custom-face-attributes`
   *  entry; the value is in the shape that attribute's widget edits. */
  faceEdits?: Partial<Record<FaceAttributeKey, unknown>>
  /** Attributes the user unchecked but has not applied yet. */
  clearedAttrs?: FaceAttributeKey[]
  showAllAttributes?: boolean
  /** `custom-form`: `edit`/`selected` show widgets, `lisp` the raw expression;
   *  a face may also use `all` (every display's spec at once). */
  form?: "edit" | "lisp" | "all"
  /** `custom-comment-show`: the comment field is visible. */
  commentShown?: boolean
  commentText?: string
}

type CustomBufferSpec = {
  bufferName: string
  entries: CustomEntry[]
  /** A one-option buffer is always drawn expanded (cus-edit.el `:custom-state 'unknown`). */
  single: boolean
  /** Flattened entry list (top level plus group members) from the last render. */
  flat?: CustomEntry[]
  searchText?: string
  /** Empty-buffer note, e.g. "No Custom themes match." */
  emptyMessage?: string
}

type FieldRef =
  | { kind: "search" }
  | { kind: "value"; entry: number; path: ValuePath }
  | { kind: "comment"; entry: number }
  | { kind: "theme-name" }
  | { kind: "theme-description" }
  | { kind: "dirlocal"; spec: number; setting: number; part: "name" | "value" }
  | { kind: "dirlocals-file" }

type CustomField = {
  start: number
  end: number
  ref: FieldRef
  /** Rendered with a fixed `:size`, so trailing padding is not part of the value. */
  padded?: boolean
}

type WidgetAction =
  | { type: "manual" }
  | { type: "search" }
  | { type: "revert-menu" }
  | { type: "apply" }
  | { type: "apply-and-save" }
  | { type: "visibility"; entry: number }
  | { type: "state"; entry: number }
  | { type: "toggle"; entry: number; path: ValuePath }
  | { type: "value-menu"; entry: number; path: ValuePath }
  | { type: "set-checkbox"; entry: number; path: ValuePath; option: number }
  | { type: "insert"; entry: number; path: ValuePath; index: number }
  | { type: "delete"; entry: number; path: ValuePath; index: number }
  | { type: "doc"; entry: number }
  | { type: "group-link"; group: string }
  | { type: "face-link"; face: string }
  | { type: "attr-checkbox"; entry: number; attr: FaceAttributeKey }
  | { type: "show-all-attributes"; entry: number }
  | { type: "browse-toggle"; group: string }
  | { type: "browse-visit"; kind: "group" | "variable" | "face"; name: string }
  | { type: "new-theme"; action: "visit" | "merge" | "revert" | "save" | "remove-saved" | "insert-face" | "insert-variable" }
  | { type: "dirlocals"; action: "save" | "revert" | "insert-spec" | "delete-spec" | "insert-setting" | "delete-setting"; index?: number; setting?: number }
  | { type: "field"; ref: FieldRef }

type CustomWidget = { start: number; end: number; action: WidgetAction }

/** `*Customize Browser*` tree state: which group nodes are expanded. */
type BrowseState = { root: string; expanded: Set<string> }

/** `*Custom Theme*` (custom-new-theme-mode) state. */
type NewThemeState = {
  themeName: string
  description: string
  faces: string[]
  variables: string[]
  removeSaved: boolean
}

// ---------------------------------------------------------------------------
// Modes and keymaps
// ---------------------------------------------------------------------------

/** `custom-field-keymap`: widget-field-keymap plus Custom-set/Custom-save. */
const customFieldKeymap = new Keymap("custom-field-keymap")

export function installCustomizeMode(): void {
  // `custom-mode-map` (cus-edit.el) = widget-keymap + the bindings below.
  const keymap = new Keymap("custom-mode-map")
  for (const key of ["return", "enter", "RET"]) keymap.bind(key, "Custom-newline")
  keymap.bind("tab", "widget-forward")
  keymap.bind("C-i", "widget-forward")
  keymap.bind("M-tab", "widget-backward")
  keymap.bind("C-M-i", "widget-backward")
  keymap.bind("S-tab", "widget-backward")
  keymap.bind("backtab", "widget-backward")
  keymap.bind("space", "scroll-up-command")
  keymap.bind("S-space", "scroll-down-command")
  keymap.bind("backspace", "scroll-down-command")
  keymap.bind("DEL", "scroll-down-command")
  keymap.bind("C-c C-c", "Custom-set")
  keymap.bind("C-x C-s", "Custom-save")
  keymap.bind("q", "Custom-buffer-done")
  keymap.bind("u", "Custom-goto-parent")
  keymap.bind("n", "widget-forward")
  keymap.bind("p", "widget-backward")
  keymap.bind("H", "custom-toggle-hide-all-widgets")
  // `"<remap> <self-insert-command>" #'Custom-no-edit`: the buffer is writable,
  // but only inside editable fields, which install `custom-field-keymap`.
  keymap.remap("self-insert-command", "Custom-no-edit")
  defineMode({ name: "customize-mode", parent: "text", keymap, fontLock: customFontLock })
  // Emacs' major mode is `Custom-mode'; `customize-mode' is the command that
  // customizes a mode's group. Both names resolve to the same mode here.
  defineMode({ name: "Custom-mode", parent: "customize-mode", keymap })

  for (const key of ["return", "enter", "RET"]) customFieldKeymap.bind(key, "widget-field-activate")
  customFieldKeymap.bind("tab", "widget-forward")
  customFieldKeymap.bind("S-tab", "widget-backward")
  customFieldKeymap.bind("backtab", "widget-backward")
  customFieldKeymap.bind("M-tab", "widget-complete")
  customFieldKeymap.bind("C-M-i", "widget-complete")
  customFieldKeymap.bind("C-k", "widget-kill-line")
  customFieldKeymap.bind("C-e", "widget-end-of-line")
  customFieldKeymap.bind("C-c C-c", "Custom-set")
  customFieldKeymap.bind("C-x C-s", "Custom-save")
  // Inside a field ordinary keys self-insert: shadow custom-mode-map's remap.
  customFieldKeymap.remap("self-insert-command", "self-insert-command")

  // `custom-theme-choose-mode-map` = widget-keymap + special-mode-map, plus
  // C-x C-s / n / p / ?. Note that SPC, DEL, <, > and q all come from
  // special-mode-map, so SPC scrolls here rather than toggling a widget.
  const themeKeymap = new Keymap("custom-theme-choose-mode-map")
  for (const key of ["return", "enter", "RET", "C-m"]) themeKeymap.bind(key, "widget-button-press")
  themeKeymap.bind("tab", "widget-forward")
  themeKeymap.bind("C-i", "widget-forward")
  themeKeymap.bind("M-tab", "widget-backward")
  themeKeymap.bind("S-tab", "widget-backward")
  themeKeymap.bind("backtab", "widget-backward")
  themeKeymap.bind("C-x C-s", "custom-theme-save")
  themeKeymap.bind("n", "widget-forward")
  themeKeymap.bind("p", "widget-backward")
  themeKeymap.bind("?", "custom-describe-theme")
  // special-mode-map inheritance.
  themeKeymap.bind("space", "scroll-up-command")
  themeKeymap.bind("S-space", "scroll-down-command")
  themeKeymap.bind("backspace", "scroll-down-command")
  themeKeymap.bind("DEL", "scroll-down-command")
  themeKeymap.bind("h", "describe-mode")
  themeKeymap.bind(">", "end-of-buffer")
  themeKeymap.bind("<", "beginning-of-buffer")
  themeKeymap.bind("g", "revert-buffer")
  themeKeymap.bind("q", "Custom-buffer-done")
  defineMode({ name: "custom-theme-choose-mode", parent: "text", keymap: themeKeymap, fontLock: themeChooserFontLock })

  // `custom-new-theme-mode-map` (cus-theme.el): widget-keymap + special-mode-map
  // + C-x C-s -> custom-theme-write.
  const newThemeKeymap = new Keymap("custom-new-theme-mode-map")
  for (const key of ["return", "enter", "RET", "C-m"]) newThemeKeymap.bind(key, "widget-button-press")
  newThemeKeymap.bind("tab", "widget-forward")
  newThemeKeymap.bind("C-i", "widget-forward")
  newThemeKeymap.bind("M-tab", "widget-backward")
  newThemeKeymap.bind("S-tab", "widget-backward")
  newThemeKeymap.bind("backtab", "widget-backward")
  newThemeKeymap.bind("C-x C-s", "custom-theme-write")
  newThemeKeymap.bind("space", "scroll-up-command")
  newThemeKeymap.bind("S-space", "scroll-down-command")
  newThemeKeymap.bind("DEL", "scroll-down-command")
  newThemeKeymap.bind("<", "beginning-of-buffer")
  newThemeKeymap.bind(">", "end-of-buffer")
  newThemeKeymap.bind("?", "describe-mode")
  newThemeKeymap.bind("h", "describe-mode")
  newThemeKeymap.bind("g", "revert-buffer")
  newThemeKeymap.bind("n", "widget-forward")
  newThemeKeymap.bind("p", "widget-backward")
  newThemeKeymap.bind("q", "Custom-buffer-done")
  defineMode({ name: "custom-new-theme-mode", parent: "text", keymap: newThemeKeymap, fontLock: customFontLock })

  // `custom-browse-mode` is Custom-mode in Emacs; the alias keeps the tree
  // buffer's own keymap discoverable by name.
  defineMode({ name: "customize-browse-mode", parent: "customize-mode", keymap })

  // Emacs has no separate face major mode: `customize-face' uses Custom-mode.
  // The alias keeps `M-x customize-face-mode' style lookups working.
  defineMode({ name: "customize-face-mode", parent: "customize-mode", keymap })
}

/** cus-edit.el propertizes each widget as it inserts it; we record the same
 *  regions while rendering and hand them straight to the display layer. */
function customFontLock(buffer: BufferModel, range?: { start: number; end: number }): TextSpan[] {
  const spans = (buffer.locals.get(CUSTOM_SPANS_KEY) as TextSpan[] | undefined) ?? []
  if (!range) return spans
  return spans.filter(span => span.end > range.start && span.start < range.end)
}

/** The theme chooser is plain text, so its faces come from the line shapes. */
function themeChooserFontLock(buffer: BufferModel, range?: { start: number; end: number }): TextSpan[] {
  const spans: TextSpan[] = []
  const text = buffer.text
  const push = (start: number, end: number, face: FaceName) => {
    if (end > start) spans.push({ start, end, face })
  }
  for (const match of text.matchAll(THEME_ROW_RE_G)) {
    const at = match.index ?? 0
    // `[X]` checkbox, then the theme name, then its summary.
    push(at, at + 3, "custom-button-unraised")
    const nameStart = at + 4
    push(nameStart, nameStart + match[2]!.length + 1, "custom-variable-tag")
    const lineEnd = text.indexOf("\n", at)
    push(at + match[0].length, lineEnd < 0 ? text.length : lineEnd, "custom-documentation")
  }
  for (const label of [THEME_SAVE_BUTTON, THEME_MIGRATE_BUTTON]) {
    const at = text.indexOf(label)
    if (at >= 0) push(at, at + label.length, label === THEME_MIGRATE_BUTTON ? "custom-link" : "custom-button-unraised")
  }
  const multiple = text.indexOf(`] ${THEME_MULTIPLE_LABEL}`)
  if (multiple >= 0) push(multiple - 2, multiple + 1, "custom-button-unraised")
  if (!range) return spans
  return spans.filter(span => span.end > range.start && span.start < range.end)
}

let pointKeymapInstalled = false

function installFieldPointKeymap(): void {
  if (pointKeymapInstalled) return
  pointKeymapInstalled = true
  addPointKeymapSource((buffer, point) => fieldAt(buffer, point) ? customFieldKeymap : null)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function installCustomizeCommands(editor: Editor): void {
  if (!getMode("customize-mode")) installCustomizeMode()
  installFieldPointKeymap()

  // cus-edit.el puts `customize' under `help'; the rest hang off it.
  defgroup("customize", "Customization of the Customization support.", { parent: "help" })
  defgroup("custom-buffer", "Control the customization buffer.", { parent: "customize" })
  defgroup("custom-browse", "Control the customization browser.", { parent: "customize" })
  defgroup("custom-faces", "Faces used by customize.", { parent: "customize" })

  defcustom("custom-theme-allow-multiple-selections", "boolean", false,
    "Whether to allow multi-selections in the *Custom Themes* buffer.", "custom-buffer")
  defcustom("custom-enabled-themes", "sexp", [] as string[],
    "List of enabled Custom themes, highest precedence last.", "customize")
  defcustom("custom-buffer-sort-alphabetically", "boolean", true,
    "Whether to sort customization groups alphabetically in Custom buffer.", "custom-buffer")
  defcustom("custom-buffer-verbose-help", "boolean", true,
    "If non-nil, include explanatory text in the customization buffer.", "custom-buffer")
  defcustom("custom-unlispify-tag-names", "boolean", true,
    "Display tag names as words instead of symbols if non-nil.", "custom-buffer")
  defcustom("custom-browse-sort-alphabetically", "boolean", false,
    "If non-nil, sort customization group alphabetically in the browser.", "custom-browse")
  defcustom("custom-file", "string", null,
    "File used for storing customization information.", "customize")

  editor.command("customize", ({ editor }) => {
    showGroupBuffer(editor, TOP_CUSTOM_GROUP)
  }, "Select a customization buffer which you can use to set user options.")

  editor.command("customize-group", async ({ editor, args }) => {
    const group = args[0] ?? await readGroup(editor)
    if (!group) return
    showGroupBuffer(editor, group)
  }, "Customize GROUP, which must be a customization group.")

  editor.command("customize-group-other-window", async ctx => {
    await ctx.editor.run("customize-group", ctx.args)
    showCurrentBufferInOtherWindow(ctx.editor)
  }, "Customize GROUP, which must be a customization group, in another window.")

  editor.command("customize-variable", async ({ editor, args }) => {
    const name = args[0] ?? await editor.completingRead("Customize variable: ", {
      collection: listCustomVariables().map(variable => variable.name),
      history: "variable",
    })
    if (!name) return
    if (!getCustomVariable(name)) {
      editor.message(`No user option named ${name}`)
      return
    }
    showCustomBuffer(editor, {
      bufferName: `*Customize Option: ${unlispifyTagName(name)}*`,
      entries: [{ kind: "variable", name }],
      single: true,
    })
  }, "Customize SYMBOL, which must be a user option.")

  editor.command("customize-variable-other-window", async ctx => {
    await ctx.editor.run("customize-variable", ctx.args)
    showCurrentBufferInOtherWindow(ctx.editor)
  }, "Customize SYMBOL, which must be a user option, in another window.")

  editor.command("customize-option", async ctx => {
    await ctx.editor.run("customize-variable", ctx.args)
  }, "Customize SYMBOL, which must be a user option.")

  editor.command("customize-option-other-window", async ctx => {
    await ctx.editor.run("customize-variable-other-window", ctx.args)
  }, "Customize SYMBOL, which must be a user option, in another window.")

  editor.command("customize-toggle-option", async ({ editor, args }) => {
    const name = args[0] ?? await editor.completingRead("Toggle boolean option: ", {
      collection: listCustomVariables().filter(v => v.type === "boolean").map(v => v.name),
      history: "variable",
    })
    if (!name) return
    const variable = getCustomVariable(name)
    if (!variable) return void editor.message(`No user option named ${name}`)
    const next = !variable.value
    setCustom(name, next)
    editor.message(`${next ? "Enabled" : "Disabled"} user options \u2018${name}\u2019.`)
    refreshCustomizeBuffer(editor, name)
  }, "Toggle the value of boolean option SYMBOL for this session.")

  editor.command("toggle-option", async ctx => {
    await ctx.editor.run("customize-toggle-option", ctx.args)
  }, "Toggle the value of boolean option SYMBOL for this session.")

  editor.command("customize-set-variable", async ({ editor, args, prefixArgument }) => {
    await customizeSetVariable(editor, args, "set", prefixArgument != null)
  }, "Set the default for VARIABLE to VALUE.")

  editor.command("customize-set-value", async ({ editor, args, prefixArgument }) => {
    // cus-edit.el: this is a plain `set', with no `customized-value' recorded,
    // so the option reads back as CHANGED outside Customize, not SET.
    await customizeSetVariable(editor, args, "set-value", prefixArgument != null)
  }, "Set VARIABLE to VALUE.")

  editor.command("customize-save-variable", async ({ editor, args, prefixArgument }) => {
    await customizeSetVariable(editor, args, "save", prefixArgument != null)
  }, "Set VARIABLE to VALUE and save it for future sessions.")

  editor.command("customize-reset-variable", ({ editor, args }) => {
    const name = args[0] ?? variableAtPoint(editor)
    if (!name) return editor.message("No customizable option at point")
    if (!resetCustom(name)) return editor.message(`Cannot reset ${name}`)
    editor.message(`Reset ${name} to standard value`)
    refreshCustomizeBuffer(editor, name)
  }, "Reset VARIABLE to its standard value, erasing any customization.")

  editor.command("customize-reset-variable-to-saved", ({ editor, args }) => {
    const name = args[0] ?? variableAtPoint(editor)
    if (!name) return editor.message("No customizable option at point")
    if (!resetCustomToSaved(name)) return editor.message(`No saved value for ${name}`)
    editor.message(`Reset ${name} to saved value`)
    refreshCustomizeBuffer(editor, name)
  }, "Reset VARIABLE to its saved value.")

  editor.command("customize-describe-variable", async ({ editor, args }) => {
    const name = args[0] ?? variableAtPoint(editor)
    if (!name) return editor.message("No customizable option at point")
    await editor.run("describe-variable", [name])
  }, "Describe the customizable option at point.")

  editor.command("customize-refresh", ({ editor }) => {
    refreshCustomizeBuffer(editor)
  }, "Redisplay the current Customize buffer.")

  editor.command("customize-save-customized", async ({ editor }) => {
    const variables = listCustomVariables().filter(variable => isUnsavedCustom(variable))
    for (const variable of variables) saveCustom(variable.name)
    const faces = listKnownFaceNames().filter(name => faceIsUnsaved(name))
    for (const name of faces) saveFace(name)
    saveEnabledBuiltinThemes()
    await saveCustomFile()
    const total = variables.length + faces.length
    editor.message(`Saved ${total} customized setting${total === 1 ? "" : "s"}`)
    refreshCustomizeBuffer(editor)
  }, "Save all user options which have been set in this session.")

  editor.command("customize-customized", async ctx => {
    await ctx.editor.run("customize-unsaved", ctx.args)
  }, "Customize all options and faces set in this session but not saved.")

  editor.command("customize-unsaved", ({ editor }) => {
    const entries = unsavedEntries()
    if (!entries.length) throw new Error("No user options are set but unsaved")
    showCustomBuffer(editor, { bufferName: "*Customize Unsaved*", entries, single: entries.length === 1 })
  }, "Customize all options and faces set in this session but not saved.")

  editor.command("customize-saved", ({ editor }) => {
    const entries: CustomEntry[] = [
      ...listKnownFaceNames().filter(name => getCustomFace(name)?.savedSpec)
        .map((name): CustomEntry => ({ kind: "face", name })),
      ...listCustomVariables().filter(variable => variable.savedValue !== undefined)
        .map((variable): CustomEntry => ({ kind: "variable", name: variable.name })),
    ]
    if (!entries.length) throw new Error("No saved user options")
    showCustomBuffer(editor, { bufferName: "*Customize Saved*", entries, single: entries.length === 1 })
  }, "Customize all saved options and faces.")

  editor.command("customize-rogue", ({ editor }) => {
    const entries = listCustomVariables().filter(variable => variable.patched)
      .map((variable): CustomEntry => ({ kind: "variable", name: variable.name }))
    if (!entries.length) throw new Error("No rogue user options")
    showCustomBuffer(editor, { bufferName: "*Customize Rogue*", entries, single: entries.length === 1 })
  }, "Customize all user variables modified outside customize.")

  editor.command("customize-changed", async ({ editor, args }) => {
    // cus-edit.el reads a version and lists everything introduced or changed
    // since it. Jemacs has no per-option `:version`, so every option whose
    // meaning could have changed is exactly the set that is not at standard.
    const since = args[0] ?? await editor.prompt("Customize options changed, since version (default all versions): ", "", "customize-changed")
    const entries = listCustomVariables()
      .filter(variable => variable.customized || variable.patched)
      .map((variable): CustomEntry => ({ kind: "variable", name: variable.name }))
    if (!entries.length) {
      editor.message(since
        ? `No user option changed since ${since}`
        : "No user option changed")
      return
    }
    showCustomBuffer(editor, { bufferName: "*Customize Changed Options*", entries, single: false })
  }, "Customize all settings whose meanings have changed in some version.")

  editor.command("customize-changed-options", async ctx => {
    await ctx.editor.run("customize-changed", ctx.args)
  }, "Customize all settings whose meanings have changed in some version.")

  editor.command("customize-mode", async ({ editor, args }) => {
    const mode = args[0] ?? await editor.completingRead("Customize mode: ", {
      collection: modeGroupCandidates(),
      history: "customize-mode",
      initialValue: editor.currentBuffer.mode,
    })
    if (!mode) return
    showGroupBuffer(editor, groupForMode(mode))
  }, "Customize options related to a major or minor mode.")

  editor.command("customize-apropos", async ({ editor, args }) => {
    await customizeApropos(editor, args, "all")
  }, "Customize loaded options, faces and groups matching PATTERN.")

  editor.command("customize-apropos-options", async ({ editor, args }) => {
    await customizeApropos(editor, args, "options")
  }, "Customize all loaded customizable options matching REGEXP.")

  editor.command("customize-apropos-groups", async ({ editor, args }) => {
    await customizeApropos(editor, args, "groups")
  }, "Customize all loaded groups matching REGEXP.")

  editor.command("customize-apropos-faces", async ({ editor, args }) => {
    await customizeApropos(editor, args, "faces")
  }, "Customize all loaded faces matching REGEXP.")

  editor.command("customize-face", async ({ editor, args }) => {
    const name = args[0] ?? await editor.completingRead("Customize face: ", {
      collection: ["all faces", ...listKnownFaceNames()],
      history: "customize-face",
    })
    if (!name || name === "all faces") {
      const entries = listKnownFaceNames().map((face): CustomEntry => ({ kind: "face", name: face }))
      showCustomBuffer(editor, { bufferName: "*Customize Faces*", entries, single: false })
      return
    }
    showCustomBuffer(editor, {
      bufferName: `*Customize Face: ${unlispifyTagName(name)}*`,
      entries: [{ kind: "face", name }],
      single: true,
    })
  }, "Customize FACE, which should be a face name or nil.")

  editor.command("customize-face-other-window", async ctx => {
    await ctx.editor.run("customize-face", ctx.args)
    showCurrentBufferInOtherWindow(ctx.editor)
  }, "Show customization buffer for FACE in other window.")

  editor.command("customize-set-face", async ({ editor, args }) => {
    await customizeSetFace(editor, args, false)
  }, "Set a face attribute for the current session.")

  editor.command("customize-save-face", async ({ editor, args }) => {
    await customizeSetFace(editor, args, true)
  }, "Set a face attribute and save it for future sessions.")

  editor.command("customize-reset-face", ({ editor, args }) => {
    const name = args[0] ?? faceAtPoint(editor)
    if (!name) return editor.message("No face at point")
    if (!resetFace(name)) return editor.message(`Unknown face: ${name}`)
    editor.refreshComposedTheme()
    editor.message(`Reset face ${name}`)
    refreshCustomizeBuffer(editor, name)
  }, "Reset FACE to its standard definition.")

  editor.command("customize-reset-face-to-saved", ({ editor, args }) => {
    const name = args[0] ?? faceAtPoint(editor)
    if (!name) return editor.message("No face at point")
    if (!resetFaceToSaved(name)) return editor.message(`No saved value for face ${name}`)
    editor.refreshComposedTheme()
    editor.message(`Reset face ${name} to saved value`)
    refreshCustomizeBuffer(editor, name)
  }, "Reset FACE to its saved customization.")

  editor.command("customize-icon", async ({ editor, args }) => {
    const name = args[0] ?? await editor.completingRead("Customize icon: ", {
      collection: listCustomIcons().map(icon => icon.name),
      history: "customize-icon",
    })
    if (!name) throw new Error("No icon specified")
    if (!getCustomIcon(name)) throw new Error(`${name} is not a valid icon`)
    showCustomBuffer(editor, {
      bufferName: `*Customize Icon: ${unlispifyTagName(name)}*`,
      entries: [{ kind: "icon", name }],
      single: true,
    })
  }, "Customize ICON.")

  editor.command("customize-dirlocals", async ({ editor, args }) => {
    const file = args[0] ?? join(editor.currentBuffer.directory() ?? process.cwd(), ".dir-locals.el")
    await showDirlocalsBuffer(editor, file)
  }, "Customize Directory Local Variables in the current directory.")

  editor.command("Custom-dirlocals-revert-buffer", async ({ editor }) => {
    const state = dirlocalsState(editor.currentBuffer)
    if (!state) return void editor.message("Not a dirlocals buffer")
    await showDirlocalsBuffer(editor, state.file)
  }, "Revert the buffer for Directory Local Variables customization.")

  editor.command("Custom-dirlocals-save", async ({ editor }) => {
    const buffer = editor.currentBuffer
    const state = dirlocalsState(buffer)
    if (!state) return void editor.message("Not a dirlocals buffer")
    captureDirlocalsFields(buffer, state)
    await writeFile(state.file, formatDirLocals(state.settings), "utf8")
    editor.message(`Wrote ${state.file}`)
    await showDirlocalsBuffer(editor, state.file)
  }, "Save the settings to the dir-locals file being customized.")

  editor.command("customize-browse", ({ editor, args }) => {
    showBrowseBuffer(editor, { root: args[0] ?? TOP_CUSTOM_GROUP, expanded: new Set([args[0] ?? TOP_CUSTOM_GROUP]) })
  }, "Create a tree browser for the customize hierarchy.")

  editor.command("custom-buffer-create-other-window", async ctx => {
    // cus-edit.el's entry point for building a Custom buffer in another window;
    // ARGS name the settings to show, defaulting to the whole `emacs' group.
    const names = ctx.args.length ? ctx.args : [TOP_CUSTOM_GROUP]
    const entries = names.map((name): CustomEntry =>
      getCustomGroup(name) ? { kind: "group", name }
        : getCustomVariable(name) ? { kind: "variable", name }
          : { kind: "face", name })
    showCustomBuffer(ctx.editor, {
      bufferName: "*Customization*",
      entries,
      single: entries.length === 1,
    })
    showCurrentBufferInOtherWindow(ctx.editor)
  }, "Create a buffer containing OPTIONS, and display it in another window.")

  // ---- Custom-mode commands ----------------------------------------------

  editor.command("Custom-set", async ({ editor }) => {
    await customCommandApply(editor, "set", "Set all values according to this buffer? ")
  }, "Set the current value of all edited settings in the buffer.")

  editor.command("Custom-save", async ({ editor }) => {
    await customCommandApply(editor, "save", "Save all settings in this buffer? ")
  }, "Set all edited settings, then save all settings that have been set.")

  editor.command("Custom-reset-current", async ({ editor }) => {
    await customCommandApply(editor, "reset-current",
      "Reset all settings' buffer text to show current values? ")
  }, "Reset all edited settings in the buffer to show their current values.")

  editor.command("Custom-reset-saved", async ({ editor }) => {
    await customCommandApply(editor, "reset-saved",
      "Reset all settings (current values and buffer text) to saved values? ")
  }, "Reset all edited or set settings in the buffer to their saved value.")

  editor.command("Custom-reset-standard", async ({ editor }) => {
    await customCommandApply(editor, "reset-standard",
      "The settings will revert to their default values, in this\nand future sessions. Really erase customizations? ")
  }, "Erase all customizations (either current or saved) in current buffer.")

  editor.command("Custom-buffer-done", async ({ editor }) => {
    await editor.run("quit-window")
  }, "Exit current Custom buffer.")

  editor.command("Custom-goto-parent", async ({ editor }) => {
    const match = /^Parent groups: \[(.+?)\]/m.exec(editor.currentBuffer.text)
    if (!match) return
    await editor.run("customize-group", [lispifyTagName(match[1]!)])
  }, "Go to the parent group listed at the top of this buffer.")

  editor.command("Custom-help", ({ editor }) => {
    editor.scratch("*Help*", [
      "Easy Customization",
      "",
      "Use Customize buffers to inspect, set, save, and reset options, faces, and themes.",
    ].join("\n"), "help")
  }, "Read the node on Easy Customization in the Emacs manual.")

  editor.command("Custom-mode", ({ editor, buffer }) => {
    editor.enterMode(buffer, "customize-mode")
  }, "Major mode for editing customization buffers.")

  editor.command("Custom-mode-menu", ({ editor }) => {
    editor.message("Customize menu is represented by Customize keymaps")
  }, "Menu used in customization buffers.")

  editor.command("Custom-newline", async ({ editor }) => {
    await invokeWidgetAtPoint(editor)
  }, "Invoke button at point, or refuse to allow editing of Custom buffer.")

  editor.command("Custom-no-edit", () => {
    throw new Error("You can't edit this part of the Custom buffer")
  }, "Invoke button at point, or refuse to allow editing of Custom buffer.")

  editor.command("custom-toggle-hide-all-widgets", ({ editor }) => {
    const spec = bufferSpec(editor.currentBuffer)
    if (!spec) return void editor.message("Not a Custom buffer")
    captureFieldEdits(editor.currentBuffer)
    const items = specApplyEntries(spec).filter(entry => entry.kind !== "group")
    const anyShown = items.some(entry => !entryHidden(entry, spec))
    for (const entry of items) entry.hidden = anyShown
    renderCustomBuffer(editor, spec)
    editor.message(anyShown ? "All variables hidden" : "All variables shown")
  }, "Hide or show details of all customizable settings in a Custom buffer.")

  editor.command("custom-comment-show", ({ editor }) => {
    const buffer = editor.currentBuffer
    const spec = bufferSpec(buffer)
    if (!spec) return void editor.message("Not a Custom buffer")
    captureFieldEdits(buffer)
    const name = variableAtPoint(editor) ?? faceAtPoint(editor)
    const entry = name ? findEntry(spec, name) : undefined
    if (!entry) return void editor.message("No customizable setting at point")
    entry.commentShown = true
    renderCustomBuffer(editor, spec, { focus: entry.name })
  }, "Show the comment field for the setting at point.")

  editor.command("custom-variable-edit", ({ editor }) => {
    setEntryForm(editor, "edit")
  }, "Edit the value of the option at point using widgets.")

  editor.command("custom-variable-edit-lisp", ({ editor }) => {
    setEntryForm(editor, "lisp")
  }, "Edit the value of the option at point as a Lisp expression.")

  // ---- widget commands ----------------------------------------------------

  editor.command("widget-forward", ({ editor, prefixArgument }) => {
    moveWidget(editor, prefixArgument ?? 1)
  }, "Move point to the next field or button.")

  editor.command("widget-backward", ({ editor, prefixArgument }) => {
    moveWidget(editor, -(prefixArgument ?? 1))
  }, "Move point to the previous field or button.")

  editor.command("widget-button-press", async ({ editor }) => {
    await invokeWidgetAtPoint(editor)
  }, "Invoke button at point.")

  editor.command("widget-button-click", async ({ editor, args }) => {
    // The mouse equivalent of widget-button-press: move to the clicked offset
    // (when one was supplied) and invoke whatever button lives there.
    const offset = args[0] != null ? Number(args[0]) : NaN
    if (Number.isFinite(offset)) editor.currentBuffer.point = offset
    await invokeWidgetAtPoint(editor)
  }, "Invoke the button that the mouse is pointing at.")

  editor.command("widget-field-activate", async ({ editor }) => {
    const field = fieldAt(editor.currentBuffer, editor.currentBuffer.point)
    if (!field) return void await invokeWidgetAtPoint(editor)
    if (field.ref.kind === "search") {
      const pattern = fieldText(editor.currentBuffer, field).trim()
      if (pattern) await editor.run("customize-apropos", [pattern])
      return
    }
    await customCommandApply(editor, "set", "Set all values according to this buffer? ")
  }, "Invoke the editable field at point.")

  editor.command("widget-complete", ({ editor }) => {
    editor.message("No widget completion available")
  }, "Complete content of editable field from point.")

  editor.command("widget-kill-line", ({ editor, buffer }) => {
    const field = fieldAt(buffer, buffer.point)
    if (!field) return void editor.run("kill-line")
    const end = Math.min(field.end, buffer.lineBoundsAt().end)
    if (end > buffer.point) buffer.deleteRange(buffer.point, end)
  }, "Kill to end of field or end of line, whichever is first.")

  editor.command("widget-end-of-line", ({ buffer }) => {
    const field = fieldAt(buffer, buffer.point)
    buffer.point = field ? field.end : buffer.lineBoundsAt().end
  }, "Go to end of field or end of line, whichever is first.")

  editor.command("widget-describe", async ({ editor }) => {
    const name = variableAtPoint(editor)
    if (name) return void await editor.run("describe-variable", [name])
    const theme = customizeThemeAtPoint(editor)
    if (theme) return void await editor.run("describe-theme", [theme])
    const face = faceAtPoint(editor)
    if (face) return void await editor.run("customize-face", [face])
    editor.message("No widget at point")
  }, "Describe the widget at point.")

  editor.command("widget-browse", ({ editor, args }) => {
    showWidgetBrowser(editor, args[0])
  }, "Create a widget browser for WIDGET.")

  editor.command("widget-browse-at", ({ editor }) => {
    showWidgetBrowser(editor, variableAtPoint(editor) ?? customizeThemeAtPoint(editor) ?? faceAtPoint(editor) ?? "point")
  }, "Create a widget browser for the widget at point.")

  editor.command("widget-browse-other-window", ({ editor, args }) => {
    showWidgetBrowser(editor, args[0])
    showCurrentBufferInOtherWindow(editor)
  }, "Create a widget browser for WIDGET in another window.")

  editor.command("widget-minor-mode", ({ editor }) => {
    editor.message("Widget minor mode is represented by Customize keymaps")
  }, "Minor mode for traversing widgets.")

  // ---- themes (cus-theme.el) ---------------------------------------------

  editor.command("customize-themes", ({ editor }) => {
    showCustomizeThemesBuffer(editor)
  }, "Display a selectable list of Custom themes.")

  editor.command("custom-theme-save", async ({ editor }) => {
    saveEnabledBuiltinThemes()
    // `custom-theme-save` in cus-theme.el saves the `custom-enabled-themes' option.
    saveCustom("custom-enabled-themes", listEnabledBuiltinThemes())
    await saveCustomFile()
    editor.message("Custom themes saved for future sessions.")
    if (editor.currentBuffer.locals.get(CUSTOMIZE_THEME_KEY)) refreshCustomizeBuffer(editor)
  }, "Save the selected themes for future sessions.")

  editor.command("custom-describe-theme", async ({ editor }) => {
    const name = customizeThemeAtPoint(editor)
    if (!name) return void editor.message("No theme at point")
    await editor.run("describe-theme", [name])
  }, "Describe the Custom theme on the current line.")

  editor.command("custom-theme-checkbox-toggle", async ({ editor }) => {
    const name = customizeThemeAtPoint(editor)
    if (!name) return void editor.message("No theme at point")
    if (isBuiltinThemeEnabled(name)) {
      await editor.run("disable-theme", [name])
      return
    }
    // Unless multi-selection is on, checking one box unchecks all the others.
    if (!getCustom<boolean>("custom-theme-allow-multiple-selections")) {
      for (const other of listEnabledBuiltinThemes()) {
        if (other !== name) disableBuiltinTheme(other)
      }
    }
    await editor.run("enable-theme", [name])
  }, "Toggle the Custom theme checkbox at point.")

  editor.command("custom-theme-choose-revert", async ({ editor }) => {
    // `revert-buffer-function` set by `custom-theme-choose-mode`.
    const answer = await editor.prompt("Discard current choices? (y or n) ", "", "custom-theme-choose-revert")
    if (answer?.trim().toLowerCase() !== "y") {
      editor.message("Revert cancelled")
      return
    }
    refreshCustomizeBuffer(editor)
  }, "Rebuild the *Custom Themes* buffer, confirming first.")

  editor.command("custom-theme-selections-toggle", ({ editor }) => {
    const allow = getCustom<boolean>("custom-theme-allow-multiple-selections") ?? false
    if (allow && listEnabledBuiltinThemes().length > 1) {
      throw new Error("More than one theme is currently selected")
    }
    setCustom("custom-theme-allow-multiple-selections", !allow)
    if (editor.currentBuffer.locals.get(CUSTOMIZE_THEME_KEY)) refreshCustomizeBuffer(editor)
  }, "Toggle whether the *Custom Themes* buffer allows multi-selection.")

  editor.command("custom-theme-visit-theme", ({ editor, args }) => {
    const name = args[0]
    if (!name || !getBuiltinTheme(name)) {
      editor.message(name ? `Unknown theme: ${name}` : "No theme specified")
      return
    }
    showNewThemeBuffer(editor, newThemeStateFor(name))
  }, "Set up a Custom buffer to edit custom theme THEME.")

  editor.command("customize-create-theme", ({ editor, args }) => {
    const name = args[0] ?? "user"
    // `user' is the pseudo-theme holding the settings the user made outside any
    // theme; cus-theme.el shows them so they can be migrated into a real theme.
    if (name !== "user" && !getBuiltinTheme(name)) return void editor.message(`Unknown theme: ${name}`)
    showNewThemeBuffer(editor, newThemeStateFor(name))
  }, "Create or edit a custom theme.")

  editor.command("custom-new-theme-mode", ({ editor, buffer }) => {
    editor.enterMode(buffer, "custom-new-theme-mode")
  }, "Major mode for the buffer created by `customize-create-theme'.")

  editor.command("custom-theme-add-variable", async ({ editor, args }) => {
    const state = newThemeState(editor.currentBuffer)
    if (!state) return void editor.message("Not a Custom Theme buffer")
    const name = args[0] ?? await editor.completingRead("Variable name: ", {
      collection: listCustomVariables().map(variable => variable.name),
      history: "variable",
    })
    if (!name) return
    if (!getCustomVariable(name)) return void editor.message(`No user option named ${name}`)
    if (!state.variables.includes(name)) state.variables.push(name)
    showNewThemeBuffer(editor, state)
  }, "Add a variable to the theme being edited.")

  editor.command("custom-theme-add-face", async ({ editor, args }) => {
    const state = newThemeState(editor.currentBuffer)
    if (!state) return void editor.message("Not a Custom Theme buffer")
    const name = args[0] ?? await editor.completingRead("Face name: ", {
      collection: listKnownFaceNames(),
      history: "customize-face",
    })
    if (!name) return
    if (!state.faces.includes(name)) state.faces.push(name)
    showNewThemeBuffer(editor, state)
  }, "Add a face to the theme being edited.")

  editor.command("custom-theme-write", async ({ editor }) => {
    const state = newThemeState(editor.currentBuffer)
    if (!state) return void editor.message("Not a Custom Theme buffer")
    captureNewThemeFields(editor.currentBuffer, state)
    const name = state.themeName.trim()
    if (!name) return void editor.message("Please specify a theme name")
    if (name === "user") return void editor.message("Custom themes cannot be named `user'")
    // Jemacs stores the user's settings in the custom file rather than a
    // separate theme file, so writing the theme saves those settings.
    for (const variable of state.variables) saveCustom(variable)
    for (const face of state.faces) saveFace(face)
    await saveCustomFile()
    editor.message(`Wrote theme ${name}`)
    showNewThemeBuffer(editor, state)
  }, "Write the theme being edited to its theme file.")
}

// ---------------------------------------------------------------------------
// Buffer construction
// ---------------------------------------------------------------------------

function showCustomBuffer(editor: Editor, spec: CustomBufferSpec): void {
  renderCustomBuffer(editor, spec, { fresh: true })
}

function renderCustomBuffer(editor: Editor, spec: CustomBufferSpec, options: { fresh?: boolean; focus?: string } = {}): void {
  const render = new CustomRender()
  renderHeader(render, spec)
  if (!spec.entries.length) {
    render.text(spec.emptyMessage ?? "No matching customization items.")
    render.nl()
  }
  for (const entry of spec.entries) {
    const index = render.entries.push(entry) - 1
    if (entry.kind === "variable") renderVariable(render, editor, spec, entry, index)
    else if (entry.kind === "face") renderFace(render, editor, spec, entry, index)
    else if (entry.kind === "icon") renderIcon(render, spec, entry, index)
    else renderGroup(render, editor, spec, entry, index)
    if (!spec.single) {
      if (!render.endsWithNewline()) render.nl()
      render.nl()
    }
  }
  if (!render.endsWithNewline()) render.nl()

  spec.flat = render.entries
  render.finish()
  const body = render.build()
  const previous = editor.currentBuffer.name === spec.bufferName ? editor.currentBuffer.point : 0
  const buffer = editor.scratch(spec.bufferName, body, "customize-mode")
  buffer.readOnly = false
  buffer.dirty = false
  buffer.locals.set(CUSTOM_SPEC_KEY, spec)
  buffer.locals.set(CUSTOM_WIDGETS_KEY, render.widgets)
  buffer.locals.set(CUSTOM_FIELDS_KEY, render.fields)
  buffer.locals.set(CUSTOM_SPANS_KEY, render.spans)
  buffer.locals.set(CUSTOMIZE_VARIABLE_KEY, render.entries.filter(e => e.kind === "variable").map(e => e.name))
  buffer.locals.set(CUSTOMIZE_FACE_KEY, render.entries.filter(e => e.kind === "face").map(e => e.name))
  buffer.locals.delete(CUSTOMIZE_THEME_KEY)
  buffer.locals.delete(CUSTOM_BROWSE_KEY)
  buffer.locals.delete(CUSTOM_NEW_THEME_KEY)
  buffer.locals.delete(CUSTOM_DIRLOCALS_KEY)
  buffer.locals.set(REVERT_BUFFER_FUNCTION_KEY, "customize-refresh")
  // Hand the field records themselves to the buffer: it keeps their bounds in
  // sync as the user types, so `captureFieldEdits` always reads the full text.
  buffer.setEditableFields(render.fields)
  // cus-edit.el ends `custom-buffer-create-internal' with (goto-char (point-min)).
  buffer.point = options.fresh ? 0 : Math.min(previous, body.length)
  if (options.focus) focusEntry(buffer, options.focus)
}

/** cus-edit.el `custom-buffer-create-internal`: help line, search field, buttons. */
/** cus-edit.el `custom-commands`: each button's `:active` states. A button
 *  whose states none of the buffer's settings are in renders inactive. */
const COMMAND_BUTTON_STATES: Record<string, CustomState[]> = {
  apply: ["modified"],
  "apply-and-save": ["modified", "set", "changed", "rogue"],
}

function commandButtonFace(spec: CustomBufferSpec, button: keyof typeof COMMAND_BUTTON_STATES): FaceName {
  const wanted = COMMAND_BUTTON_STATES[button]!
  // On the first render `spec.flat` is not built yet, so fall back to the
  // top-level entries; group members join in on the redraw after an edit.
  const entries = spec.flat ?? spec.entries
  const active = entries.some(entry => wanted.includes(entryState(entry)))
  return active ? "custom-button-unraised" : "widget-inactive"
}

function renderHeader(render: CustomRender, spec: CustomBufferSpec): void {
  render.text("For help using this buffer, see ")
  render.button("[Easy Customization]", { type: "manual" }, "custom-link")
  render.text(" in the ")
  render.button("[Emacs manual]", { type: "manual" }, "custom-link")
  render.text(".")
  render.nl()
  render.nl()
  render.field(spec.searchText ?? "", { kind: "search" }, 40)
  render.text(" ")
  render.button("[ Search ]", { type: "search" })
  render.nl()
  render.nl()
  render.text("Operate on all settings in this buffer:")
  render.nl()
  render.button("[ Revert... ]", { type: "revert-menu" })
  render.text(" ")
  render.button("[ Apply ]", { type: "apply" }, commandButtonFace(spec, "apply"))
  render.text(" ")
  render.button("[ Apply and Save ]", { type: "apply-and-save" }, commandButtonFace(spec, "apply-and-save"))
  render.nl()
  render.nl()
}

function renderVariable(render: CustomRender, editor: Editor, spec: CustomBufferSpec, entry: CustomEntry, index: number): void {
  const variable = getCustomVariable(entry.name)
  if (!variable) return
  const tag = unlispifyTagName(entry.name)
  if (entryHidden(entry, spec)) {
    render.button("Show Value", { type: "visibility", entry: index }, "custom-visibility")
    render.text(" ")
    render.faced(tag, obsoleteTag(variable))
    render.text(" ")
    render.nl()
    renderDoc(render, entry, index, variable.doc)
    return
  }
  const type: CustomType = entryType(entry, variable)
  const value = shownValue(entry, variable)
  render.button("Hide", { type: "visibility", entry: index }, "custom-visibility")
  render.text(" ")
  // cus-edit.el faces the tag itself; the `: ` separator is plain.
  render.button(tag, { type: "state", entry: index }, obsoleteTag(variable))
  render.text(":")
  if (widgetIsMultiLine(type)) {
    // cus-edit.el prints the type tag on its own line, then the elements.
    render.nl()
    renderValueWidget(render, entry, index, type, value, [])
  } else {
    render.text(` ${customTypeLabel(type)}: `)
    renderValueWidget(render, entry, index, type, value, [])
    render.nl()
  }
  render.text("   ")
  render.button("[ State ]", { type: "state", entry: index })
  render.text(": ")
  const varState = variableDisplayState(entry, variable)
  render.faced(magicText(varState, false), stateFace(varState))
  render.nl()
  renderDoc(render, entry, index, variable.doc)
  renderComment(render, entry, index, entry.commentText ?? variable.comment)
  if (variable.group) {
    render.text("Groups: ")
    render.button(`[${unlispifyTagName(variable.group)}]`, { type: "group-link", group: variable.group }, "custom-link")
    render.nl()
  }
}

/** wid-edit.el value widgets: the part after `Tag: `.
 *  ROOT is always the whole option value; PATH addresses the sub-value being
 *  drawn, so every editable field records where its text belongs. INDENT is the
 *  column nested rows start at, which wid-edit.el tracks as `:indent`. */
function renderValueWidget(
  render: CustomRender,
  entry: CustomEntry,
  index: number,
  type: CustomType,
  root: unknown,
  path: ValuePath,
  indent = 0,
  /** The caller already printed this widget's tag (a face attribute row does). */
  suppressTag = false,
): void {
  const value = getAtPath(root, path)
  const pad = " ".repeat(indent)
  if (!isCompositeType(type)) {
    if (type === "boolean") {
      render.button("[Toggle]", { type: "toggle", entry: index, path })
      render.text(`  ${value ? "on (non-nil)" : "off (nil)"}`)
      return
    }
    if (type === "face") {
      // cus-edit.el prints `Face: [link] (sample) NAME`.
      render.button("[link]", { type: "face-link", face: String(value ?? "") }, "custom-link")
      render.text(" (sample) ")
      render.field(fieldValue(entry, path, type, root), { kind: "value", entry: index, path })
      return
    }
    if (type === "color") {
      // cus-face.el's `color` widget: a 15-column field, then the picker and
      // a swatch of the colour itself.
      render.field(fieldValue(entry, path, type, root), { kind: "value", entry: index, path }, 15)
      render.text("[ Choose ]  (sample)")
      return
    }
    render.field(fieldValue(entry, path, type, root), { kind: "value", entry: index, path })
    return
  }

  switch (type.kind) {
    case "choice": {
      const arm = chosenArm(type, value)
      render.button("[Value Menu]", { type: "value-menu", entry: index, path })
      render.text(" ")
      if (arm && "type" in arm) {
        // wid-edit.el prints the arm's own tag before its widget, so a `:height`
        // scale reads `Scale: 1.2` and an `:underline` reads `On:` then rows.
        if (arm.tag) render.text(widgetIsMultiLine(arm.type) ? `${arm.tag}:` : `${arm.tag}: `)
        // The arm's tag is printed, so its widget must not repeat it; and its
        // rows belong at this row's indent, not one level further in.
        renderValueWidget(render, entry, index, arm.type, root, path, indent, true)
      } else {
        render.text(arm ? choiceLabel(arm) : formatScalar(value))
      }
      return
    }
    case "set": {
      render.text(`${customTypeLabel(type)}:`)
      render.nl()
      const selected = Array.isArray(value) ? value : []
      type.options.forEach((option, optionIndex) => {
        render.text(pad)
        const on = "const" in option && selected.some(item => deepEqual(item, option.const))
        render.button(`[${on ? "X" : " "}]`, { type: "set-checkbox", entry: index, path, option: optionIndex })
        render.text(` ${choiceLabel(option)}`)
        render.nl()
      })
      return
    }
    case "list": {
      // `(list T1 T2 ...)`: a fixed group, each child on its own line, with no
      // [INS]/[DEL] since the arity is fixed. A tagless list is an arm of a
      // choice, which has already printed the tag.
      if (type.tag) {
        render.text(`${type.tag}:`)
      }
      render.nl()
      // A standalone list sits on the row's `[INS] [DEL] ` prefix, so its
      // children start one level in; a face attribute's list is already at the
      // row's own indent and its children stay there.
      const childIndent = suppressTag ? indent : indent + WIDGET_INDENT
      type.items.forEach((itemType, itemIndex) => {
        render.text(" ".repeat(childIndent))
        if (!widgetIsMultiLine(itemType)) render.text(`${customTypeLabel(itemType)}: `)
        renderValueWidget(render, entry, index, itemType, root, [...path, itemIndex], childIndent)
        if (!render.endsWithNewline()) render.nl()
      })
      return
    }
    case "repeat":
    case "hook":
    case "alist":
    case "plist": {
      const itemType: CustomType = type.kind === "repeat" ? type.item
        : type.kind === "hook" ? "function"
          : type.kind === "alist" ? type.key
            : "symbol"
      // A `repeat` that is a face attribute's own widget has already had its
      // tag printed by the attribute row, so it prints nothing here.
      if (!(type.kind === "repeat" && suppressTag)) {
        render.text(`${customTypeLabel(type)}:`)
      }
      render.nl()
      const items = Array.isArray(value) ? value : []
      const pairKind = type.kind === "alist" || type.kind === "plist"
      const keyType: CustomType = type.kind === "alist" ? type.key : "symbol"
      const valueType: CustomType = type.kind === "alist" ? type.value : "symbol"
      items.forEach((item, itemIndex) => {
        const itemPath: ValuePath = [...path, itemIndex]
        render.text(pad)
        render.button("[INS]", { type: "insert", entry: index, path, index: itemIndex })
        render.text(" ")
        render.button("[DEL]", { type: "delete", entry: index, path, index: itemIndex })
        render.text(" ")
        if (pairKind) {
          // A plist row's tag is the bare `:`, with Key/Value on the next two
          // lines; an alist row puts its key inline and the value below.
          const inner = `${pad}${" ".repeat(WIDGET_INDENT)}`
          if (type.kind === "plist") {
            render.text(":")
            render.nl()
            render.text(`${inner}Key: `)
          } else {
            render.text(`${customTypeLabel(keyType)}: `)
          }
          renderValueWidget(render, entry, index, keyType, root, [...itemPath, "key"], indent + WIDGET_INDENT)
          render.nl()
          // cus-edit.el aligns the value under the key's field.
          render.text(`${inner}${type.kind === "plist" ? "Value" : customTypeLabel(valueType)}: `)
          renderValueWidget(render, entry, index, valueType, root, [...itemPath, "value"], indent + WIDGET_INDENT)
          render.nl()
        } else {
          if (!widgetIsMultiLine(itemType)) render.text(`${customTypeLabel(itemType)}: `)
          renderValueWidget(render, entry, index, itemType, root, itemPath, indent)
          if (!render.endsWithNewline()) render.nl()
        }
        void item
      })
      render.text(pad)
      render.button("[INS]", { type: "insert", entry: index, path, index: items.length })
      render.nl()
      return
    }
  }
}

function renderFace(render: CustomRender, editor: Editor, spec: CustomBufferSpec, entry: CustomEntry, index: number): void {
  const tag = unlispifyTagName(entry.name)
  // cus-edit.el: a tag already ending in "face" gets `[Tag]:`, else `[Tag] face:`.
  const separator = /face$/i.test(tag) ? ":" : " face: "
  const doc = getCustomFace(entry.name)?.doc
  if (entryHidden(entry, spec)) {
    render.button("Show", { type: "visibility", entry: index }, "custom-visibility")
    render.text(" ")
    render.button(`[${tag}]`, { type: "face-link", face: entry.name }, "custom-face-tag")
    render.text(separator)
    render.text("[sample]")
    render.nl()
    renderDoc(render, entry, index, doc)
    return
  }
  render.button("Hide", { type: "visibility", entry: index }, "custom-visibility")
  render.text(" ")
  render.button(`[${tag}]`, { type: "face-link", face: entry.name }, "custom-face-tag")
  render.text(separator)
  render.text("[sample]")
  render.nl()
  render.text("   ")
  render.button("[ State ]", { type: "state", entry: index })
  render.text(": ")
  const faceStateNow = faceDisplayState(entry)
  render.faced(magicText(faceStateNow, false), stateFace(faceStateNow))
  render.nl()
  renderDoc(render, entry, index, doc)

  // `custom-face-edit` is a checklist: one row per `custom-face-attributes`
  // entry, each row a checkbox plus that attribute's own widget.
  const style = faceStyleFor(editor, entry)
  for (const attrSpec of FACE_ATTRIBUTE_SPECS) {
    const set = faceAttributeIsSetOn(entry, style, attrSpec.key)
    if (!set && !entry.showAllAttributes) continue
    render.text("   ")
    render.button(`[${set ? "X" : " "}]`, { type: "attr-checkbox", entry: index, attr: attrSpec.key })
    render.text(widgetIsMultiLine(attrSpec.type) ? ` ${attrSpec.tag}:` : ` ${attrSpec.tag}: `)
    // The widget reads its value out of ROOT at PATH, so hand it a record
    // rooted the same way the field paths are: `{ attr: { KEY: value } }`.
    const root = { attr: { [attrSpec.key]: faceAttributeValue(entry, style, attrSpec) } }
    // A row's nested lines indent under its tag, not under the checkbox.
    renderValueWidget(render, entry, index, attrSpec.type, root, ["attr", attrSpec.key], FACE_ATTR_INDENT, true)
    if (!render.endsWithNewline()) render.nl()
  }
  render.text("   ")
  render.button(entry.showAllAttributes ? "Hide Unused Attributes" : "Show All Attributes",
    { type: "show-all-attributes", entry: index }, "custom-visibility")
  render.nl()
  renderComment(render, entry, index, entry.commentText ?? getFaceComment(entry.name))
}

/** The face's attributes as the widget sees them: its own spec if it has one,
 *  else what the active theme resolves it to. */
function faceStyleFor(editor: Editor, entry: CustomEntry): FaceStyle {
  return getCustomFace(entry.name)?.spec ?? resolveThemeFace(editor.theme, entry.name as FaceName) ?? {}
}

/** Is the attribute's checkbox checked? A pending edit wins over the face. */
function faceAttributeIsSetOn(entry: CustomEntry, style: FaceStyle, key: FaceAttributeKey): boolean {
  if (entry.clearedAttrs?.includes(key)) return false
  if (entry.faceEdits && key in entry.faceEdits) return true
  return faceAttributeIsSet(style, key)
}

/** The value the attribute's widget renders, including any pending edit. */
function faceAttributeValue(entry: CustomEntry, style: FaceStyle, attrSpec: FaceAttributeSpec): unknown {
  const edited = entry.faceEdits?.[attrSpec.key]
  if (edited !== undefined) return edited
  const value = faceAttributeToWidget(style, attrSpec.key)
  return value === undefined ? attrSpec.defaultValue : value
}

function renderGroup(render: CustomRender, editor: Editor, spec: CustomBufferSpec, entry: CustomEntry, index: number): void {
  const group = getCustomGroup(entry.name)
  const isRoot = entry.name === TOP_CUSTOM_GROUP
  const tag = groupTag(entry.name)
  render.faced("\n", "custom-group-rule")
  if (group?.parent) {
    render.text("Parent groups: ")
    render.button(`[${groupTag(group.parent)}]`, { type: "group-link", group: group.parent }, "custom-link")
    render.nl()
    render.nl()
  }
  render.faced(`${tag} group: `, isRoot ? "custom-group-tag" : "custom-group-tag-1")
  render.text(group?.doc ?? "Group definition missing.")
  render.nl()
  render.text("      ")
  render.button("[ State ]", { type: "state", entry: index })
  render.text(": ")
  const groupState = groupDisplayState(entry.name)
  render.faced(magicText(groupState, true), stateFace(groupState))
  render.nl()
  // `custom-add-see-also`: the group's `:link`s, indented under the state line.
  if (group?.links?.length) {
    render.text("      See also ")
    group.links.forEach((link, linkIndex) => {
      render.button(`[${link.tag}]`, { type: "manual" }, "custom-link")
      const rest = group.links!.length - linkIndex - 1
      if (rest === 0) render.text(".")
      else if (rest === 1) render.text(group.links!.length > 2 ? ", and " : " and ")
      else render.text(", ")
    })
    render.nl()
  }
  render.text(isRoot ? "" : "   ")
  render.nl()

  const members = groupMembers(entry.name)
  // Group members are `custom-group` children: reuse the child entries across
  // redraws so per-member visibility and pending edits survive a refresh.
  const children = entry.children ?? []
  entry.children = children
  for (const member of members.entries) {
    let sub = children.find(child => child.kind === member.kind && child.name === member.name)
    if (!sub) {
      sub = { kind: member.kind, name: member.name }
      children.push(sub)
    }
    const memberIndex = render.entries.push(sub) - 1
    // A group buffer is `single` at the top level, but its members are drawn
    // with the usual hidden-when-standard rule.
    const memberSpec = { ...spec, single: false }
    if (member.kind === "variable") renderVariable(render, editor, memberSpec, sub, memberIndex)
    else renderFace(render, editor, memberSpec, sub, memberIndex)
    if (!render.endsWithNewline()) render.nl()
    render.nl()
  }
  if (members.subgroups.length) {
    // `have-subtitle` in cus-edit.el is `(and (not (eq symbol 'emacs)) ...)`,
    // so the root group lists its children without the heading.
    if (!isRoot) {
      render.faced("Subgroups:", "custom-group-subtitle")
      render.nl()
    }
    for (const sub of members.subgroups) {
      const tagText = `[${groupTag(sub.name)}]`
      render.button(tagText, { type: "group-link", group: sub.name }, "custom-link")
      // cus-edit.el pads with tabs so the doc starts at `custom-group-doc-align-col`.
      // Emit the resolved spaces: a terminal pane has no tab stops of its own.
      const doc = sub.doc ? sub.doc.split("\n")[0]! : ""
      // cus-edit.el writes `"\t\t    "` after the tag: the tabs are plain and
      // only the four trailing spaces share the doc string's face.
      const pad = " ".repeat(Math.max(1, GROUP_DOC_ALIGN_COL - tagText.length))
      const faced = pad.length > GROUP_DOC_FACED_PAD ? GROUP_DOC_FACED_PAD : pad.length
      render.text(pad.slice(0, pad.length - faced))
      const more = Boolean(sub.doc && sub.doc.includes("\n"))
      // The separating space belongs to the documentation run, as in Emacs.
      render.faced(pad.slice(pad.length - faced) + doc + (more ? " " : ""), "custom-documentation")
      if (more) {
        render.button("More", { type: "group-link", group: sub.name }, "custom-visibility")
      }
      render.nl()
    }
  }
  // cus-edit.el ends `custom-group-value-create' with `(insert "\n")' followed
  // by `custom-group--draw-horizontal-line', which inserts one more newline
  // carrying `(:underline t)` to draw the rule.
  render.nl()
  render.faced("\n", "custom-group-rule")
}

/** The face of a `[ State ]` line's description.
 *
 *  cus-edit.el's `custom-magic-value-create` ends with
 *  `(put-text-property start (point) 'face 'custom-state)`, so the wording is
 *  always `custom-state` regardless of the state. `custom-magic-alist`'s
 *  per-state faces are the `:button-face` of the `[*]`/`[+]` magic glyph,
 *  which `custom-magic-show-button` leaves hidden by default. */
function stateFace(_state: CustomState): FaceName {
  return "custom-state"
}

/** cus-edit.el tags an obsolete option with `custom-variable-obsolete`. */
function obsoleteTag(variable: CustomVariable): FaceName {
  return variable.patched ? "custom-variable-obsolete" : "custom-variable-tag"
}

/** `custom-unlispify-tag-name`, honouring a group's explicit `custom-tag`. */
function groupTag(name: string): string {
  return getCustomGroup(name)?.tag ?? unlispifyTagName(name)
}

/** cus-edit.el documentation string button: first line plus `More`/`Hide`. */
function renderDoc(render: CustomRender, entry: CustomEntry, index: number, doc: string | undefined): void {
  if (!doc) return
  const lines = doc.split("\n")
  // Emacs propertizes the indent too: the run is `"   A doc."`.
  render.faced(`   ${lines[0]!}`, "custom-documentation")
  if (lines.length > 1) {
    render.text(" ")
    render.button(entry.docShown ? "Hide" : "More", { type: "doc", entry: index }, "custom-visibility")
  }
  render.nl()
  if (entry.docShown) {
    for (const line of lines.slice(1)) {
      render.faced(`   ${line}`, "custom-documentation")
      render.nl()
    }
  }
}

/** cus-edit.el `custom-comment` widget: `Comment: <field>`. */
function renderComment(render: CustomRender, entry: CustomEntry, index: number, comment: string | undefined): void {
  if (!entry.commentShown && !comment) return
  render.faced("Comment:", "custom-comment-tag")
  render.text(" ")
  render.field(comment ?? "", { kind: "comment", entry: index }, 30)
  render.nl()
}

/** The `:type` cus-edit.el gives `custom-icon`:
 *
 *      (repeat (list (choice (const :tag "Images" image) ...)
 *                    (repeat string)
 *                    plist))
 */
const ICON_TYPE: CustomType = {
  kind: "repeat",
  item: {
    kind: "list",
    tag: "List",
    items: [
      {
        kind: "choice",
        options: [
          { const: "image", tag: "Images" },
          { const: "emoji", tag: "Colorful Emojis" },
          { const: "symbol", tag: "Monochrome Symbols" },
          { const: "text", tag: "Text Only" },
        ],
      },
      { kind: "repeat", item: "string" },
      { kind: "plist" },
    ],
  },
}

/** The icon's value in the shape `ICON_TYPE` describes: one `[kind, values,
 *  keywords]` triple per display, which is `icon-spec-values` /
 *  `icon-spec-keywords` in cus-edit.el. */
function iconWidgetValue(entry: CustomEntry): unknown {
  if (entry.shown !== undefined) return entry.shown
  const icon = getCustomIcon(entry.name)
  return (icon?.spec ?? []).map(item => [item.kind, [...item.values], (item.keywords ?? []).map(pair => [...pair])])
}

/** Read the widget value back into the icon's own representation. */
function iconSpecsFromWidget(value: unknown): CustomIconSpec[] {
  if (!Array.isArray(value)) return []
  return value.map(row => {
    const [kind, values, keywords] = Array.isArray(row) ? row : []
    return {
      kind: (typeof kind === "string" ? kind : "text") as CustomIconSpec["kind"],
      values: Array.isArray(values) ? values.map(String) : [],
      keywords: Array.isArray(keywords)
        ? keywords.filter(Array.isArray).map(pair => [String(pair[0] ?? ""), String(pair[1] ?? "")] as [string, string])
        : [],
    }
  })
}

/** The widget type of a face's whole value: a record under `attr`, one member
 *  per `custom-face-attributes` entry. `typeAtPath` walks it to reach the
 *  widget that owns any given field or button. */
const FACE_WIDGET_TYPE: CustomType = {
  kind: "record",
  members: { attr: { kind: "record", members: Object.fromEntries(
    FACE_ATTRIBUTE_SPECS.map(attrSpec => [attrSpec.key, attrSpec.type]),
  ) } },
}

/** cus-edit.el `custom-icon-value-create`: an icon renders as `ICON_TYPE`. */
function renderIcon(render: CustomRender, spec: CustomBufferSpec, entry: CustomEntry, index: number): void {
  const icon = getCustomIcon(entry.name)
  const tag = unlispifyTagName(entry.name)
  if (entryHidden(entry, spec)) {
    render.button("Show Value", { type: "visibility", entry: index }, "custom-visibility")
    render.text(" ")
    render.faced(tag, "custom-variable-tag")
    render.text(" ")
    render.nl()
    renderDoc(render, entry, index, icon?.doc)
    return
  }
  render.button("Hide", { type: "visibility", entry: index }, "custom-visibility")
  render.text(" ")
  render.button(tag, { type: "state", entry: index }, "custom-variable-tag")
  render.text(":")
  render.nl()
  renderValueWidget(render, entry, index, ICON_TYPE, iconWidgetValue(entry), [])
  render.text("   ")
  render.button("[ State ]", { type: "state", entry: index })
  render.text(": ")
  const iconState2 = iconDisplayState(entry)
  render.faced(magicText(iconState2, false), stateFace(iconState2))
  render.nl()
  renderDoc(render, entry, index, icon?.doc)
  render.text("Groups: ")
  render.button(`[${icon?.group ? groupTag(icon.group) : "Nil"}]`,
    { type: "group-link", group: icon?.group ?? TOP_CUSTOM_GROUP }, "custom-link")
  render.nl()
}

function iconState(name: string): CustomState {
  const icon = getCustomIcon(name)
  if (!icon?.customized) return "standard"
  if (!icon.savedSpec) return "set"
  return JSON.stringify(icon.savedSpec) === JSON.stringify(icon.spec) ? "saved" : "set"
}

function iconDisplayState(entry: CustomEntry): CustomState {
  if (entry.shown !== undefined || entry.shownText != null) return "modified"
  return iconState(entry.name)
}

// ---------------------------------------------------------------------------
// *Customize Dirlocals* (cus-edit.el's .dir-locals.el editor)
// ---------------------------------------------------------------------------

type DirlocalsState = { file: string; settings: DirlocalsSpec[] }

function dirlocalsState(buffer: BufferModel): DirlocalsState | undefined {
  return buffer.locals.get(CUSTOM_DIRLOCALS_KEY) as DirlocalsState | undefined
}

async function showDirlocalsBuffer(editor: Editor, file: string): Promise<void> {
  let settings: DirlocalsSpec[] = []
  try {
    settings = parseDirLocals(await readFile(file, "utf8"))
  } catch { /* no file yet: start empty, as customize-dirlocals does */ }
  renderDirlocals(editor, { file, settings })
}

/** cus-edit.el `customize-dirlocals`, laid out exactly as Emacs prints it.
 *  The `File:` line is an editable field, so a blank line follows it; the
 *  explanatory text and the button row are separated the same way. */
function renderDirlocals(editor: Editor, state: DirlocalsState): void {
  const render = new CustomRender()
  render.text("This buffer is for customizing the Directory Local Variables in:\n")
  render.text("File: ")
  render.field(state.file, { kind: "dirlocals-file" })
  render.nl()
  // `\u2019` is Emacs's text-quoting-style curly apostrophe in "you've".
  render.text([
    "",
    "To select another file, edit the above field and hit RET.",
    "",
    "After you enter a user option name under the symbol field,",
    "be sure to press RET or TAB, so that the field that holds the",
    "value changes to an appropriate field for the option.",
    "",
    "Type C-x C-s when you\u2019ve finished editing it, to save the",
    "settings to the file.",
    "",
    "",
    "",
  ].join("\n"))
  render.button("[ Revert ]", { type: "dirlocals", action: "revert" })
  render.text(" ")
  render.button("[ Save Settings ]", { type: "dirlocals", action: "save" })
  render.nl()
  render.nl()
  state.settings.forEach((spec, specIndex) => {
    render.button("[INS]", { type: "dirlocals", action: "insert-spec", index: specIndex })
    render.text(" ")
    render.button("[DEL]", { type: "dirlocals", action: "delete-spec", index: specIndex })
    render.text(" Specification: ")
    render.text(spec.mode === "nil" ? "All modes" : spec.mode)
    render.nl()
    render.text("            Settings:")
    render.nl()
    spec.settings.forEach(([name, value], settingIndex) => {
      render.text("            ")
      render.button("[INS]", { type: "dirlocals", action: "insert-setting", index: specIndex, setting: settingIndex })
      render.text(" ")
      render.button("[DEL]", { type: "dirlocals", action: "delete-setting", index: specIndex, setting: settingIndex })
      render.text(" Setting:")
      render.nl()
      render.text("                        Symbol: ")
      render.field(name, { kind: "dirlocal", spec: specIndex, setting: settingIndex, part: "name" })
      render.nl()
      // `custom-dynamic-cons` picks the widget from the option's own type.
      const type = getCustomVariable(name)?.type ?? "sexp"
      render.text(`                        ${customTypeLabel(type)}: `)
      render.field(formatValue(type, value), { kind: "dirlocal", spec: specIndex, setting: settingIndex, part: "value" })
      render.nl()
    })
    render.text("            ")
    render.button("[INS]", { type: "dirlocals", action: "insert-setting", index: specIndex, setting: spec.settings.length })
    render.nl()
  })
  render.button("[INS]", { type: "dirlocals", action: "insert-spec", index: state.settings.length })
  render.nl()

  render.finish()
  const buffer = editor.scratch("*Customize Dirlocals*", render.build(), "customize-mode")
  buffer.readOnly = false
  buffer.dirty = false
  buffer.locals.set(CUSTOM_DIRLOCALS_KEY, state)
  buffer.locals.set(CUSTOM_WIDGETS_KEY, render.widgets)
  buffer.locals.set(CUSTOM_FIELDS_KEY, render.fields)
  buffer.locals.set(CUSTOM_SPANS_KEY, render.spans)
  buffer.locals.delete(CUSTOM_SPEC_KEY)
  buffer.locals.delete(CUSTOMIZE_THEME_KEY)
  buffer.locals.delete(CUSTOM_BROWSE_KEY)
  buffer.locals.delete(CUSTOM_NEW_THEME_KEY)
  buffer.locals.set(REVERT_BUFFER_FUNCTION_KEY, "Custom-dirlocals-revert-buffer")
  buffer.setEditableFields(render.fields)
  buffer.point = 0
}

function captureDirlocalsFields(buffer: BufferModel, state: DirlocalsState): void {
  for (const field of bufferFields(buffer)) {
    if (field.ref.kind !== "dirlocal") continue
    const spec = state.settings[field.ref.spec]
    const setting = spec?.settings[field.ref.setting]
    if (!setting) continue
    const text = fieldText(buffer, field)
    if (field.ref.part === "name") setting[0] = text
    else {
      const type = getCustomVariable(setting[0])?.type ?? "sexp"
      try { setting[1] = parseValue(type, text) } catch { setting[1] = text }
    }
  }
}

async function invokeDirlocalsWidget(editor: Editor): Promise<void> {
  const buffer = editor.currentBuffer
  const state = dirlocalsState(buffer)!
  captureDirlocalsFields(buffer, state)
  const widget = widgetAtPoint(buffer)
  if (widget?.action.type !== "dirlocals") return void editor.message("No widget at point")
  const action = widget.action
  const at = action.index ?? 0
  const setting = action.setting ?? 0
  switch (action.action) {
    case "save":
      await editor.run("Custom-dirlocals-save")
      return
    case "revert":
      await editor.run("Custom-dirlocals-revert-buffer")
      return
    case "insert-spec":
      state.settings.splice(at, 0, { mode: "nil", settings: [] })
      break
    case "delete-spec":
      state.settings.splice(at, 1)
      break
    case "insert-setting":
      state.settings[at]?.settings.splice(setting, 0, ["", ""])
      break
    case "delete-setting":
      state.settings[at]?.settings.splice(setting, 1)
      break
  }
  renderDirlocals(editor, state)
}

class CustomRender {
  private parts: string[] = []
  private len = 0
  readonly widgets: CustomWidget[] = []
  /** Faced regions, in the order they were emitted (`font-lock` spans). */
  readonly spans: TextSpan[] = []
  /** Spans whose face has `:extend t`; widened by `finish`. */
  private readonly extendable: TextSpan[] = []
  readonly fields: CustomField[] = []
  /** Flat entry list in render order; widget `entry` indices point here. */
  readonly entries: CustomEntry[] = []

  text(value: string): void {
    if (!value) return
    this.parts.push(value)
    this.len += value.length
  }

  nl(): void {
    this.text("\n")
  }

  /** Emit TEXT carrying FACE, as `widget-specify-*` propertizes a widget. */
  faced(value: string, face: FaceName): void {
    const start = this.len
    this.text(value)
    if (this.len > start) this.spans.push({ start, end: this.len, face })
  }

  button(label: string, action: WidgetAction, face: FaceName = "custom-button-unraised"): void {
    const start = this.len
    this.text(label)
    this.widgets.push({ start, end: this.len, action })
    this.spans.push({ start, end: this.len, face })
  }

  field(value: string, ref: FieldRef, width = 0): void {
    const start = this.len
    this.text(value.padEnd(width))
    const end = this.len
    this.widgets.push({ start, end, action: { type: "field", ref } })
    this.fields.push({ start, end, ref, padded: width > 0 })
    // `widget-field` carries `:extend t`: the highlight runs through the
    // newline that ends the field. `finish` widens these once the whole
    // buffer is built, because only then is the line end known.
    const span: TextSpan = { start, end: Math.max(end, start + 1), face: "widget-field" }
    this.spans.push(span)
    if (width === 0) this.extendable.push(span)
  }

  /** Widen every `:extend t` span to cover its terminating newline. */
  finish(): void {
    const text = this.build()
    for (const span of this.extendable) {
      const newline = text.indexOf("\n", span.end)
      if (newline >= 0) span.end = newline + 1
    }
  }

  endsWithNewline(): boolean {
    return this.len === 0 || this.parts[this.parts.length - 1]!.endsWith("\n")
  }

  build(): string {
    return this.parts.join("")
  }
}

// ---------------------------------------------------------------------------
// Buffer state helpers
// ---------------------------------------------------------------------------

function bufferSpec(buffer: BufferModel): CustomBufferSpec | undefined {
  return buffer.locals.get(CUSTOM_SPEC_KEY) as CustomBufferSpec | undefined
}

function bufferWidgets(buffer: BufferModel): CustomWidget[] {
  return (buffer.locals.get(CUSTOM_WIDGETS_KEY) as CustomWidget[] | undefined) ?? []
}

function bufferFields(buffer: BufferModel): CustomField[] {
  return (buffer.locals.get(CUSTOM_FIELDS_KEY) as CustomField[] | undefined) ?? []
}

function fieldAt(buffer: BufferModel, point: number): CustomField | undefined {
  return bufferFields(buffer).find(field => point >= field.start && point <= field.end)
}

/** wid-edit.el `widget-field-value-get`: a sized field's trailing spaces are
 *  padding, not value, so they are stripped before the text is used. */
function fieldText(buffer: BufferModel, field: CustomField): string {
  const raw = buffer.text.slice(field.start, field.end)
  return field.padded ? raw.replace(/ +$/, "") : raw
}

/** Widget `entry` indices address the flat render order, not `spec.entries`. */
function specEntry(spec: CustomBufferSpec, index: number): CustomEntry | undefined {
  return (spec.flat ?? spec.entries)[index]
}

/** Every entry a Custom command operates on: top level plus group members. */
function specApplyEntries(spec: CustomBufferSpec): CustomEntry[] {
  return spec.flat ?? spec.entries
}

function findEntry(spec: CustomBufferSpec, name: string): CustomEntry | undefined {
  return specApplyEntries(spec).find(entry => entry.name === name)
}

/** Text currently in the field for PATH: an unapplied edit, or the value. */
function fieldValue(entry: CustomEntry, path: ValuePath, type: CustomType, root: unknown): string {
  const edited = entry.shownText?.[pathKey(path)]
  if (edited != null) return edited
  return formatValue(type, getAtPath(root, path))
}

/** The value a widget renders: the edited copy if any, else the live value. */
/** The `:type` a variable widget renders with, honouring `custom-form`. */
function entryType(entry: CustomEntry, variable: CustomVariable): CustomType {
  return entry.form === "lisp" ? "sexp" : variable.type
}

function shownValue(entry: CustomEntry, variable: CustomVariable): unknown {
  return entry.shown !== undefined ? entry.shown : variable.value
}

/** Copy what the user typed into the entry model so a redraw preserves it. */
function captureFieldEdits(buffer: BufferModel): void {
  const spec = bufferSpec(buffer)
  if (!spec) return
  for (const field of bufferFields(buffer)) {
    const value = fieldText(buffer, field)
    if (field.ref.kind === "search") {
      spec.searchText = value
      continue
    }
    // Fields belonging to the theme editor and the dirlocals editor carry
    // their own state, not a Custom entry.
    if (field.ref.kind === "theme-name" || field.ref.kind === "theme-description") continue
    if (field.ref.kind === "dirlocal" || field.ref.kind === "dirlocals-file") continue
    const entry = specEntry(spec, field.ref.entry)
    if (!entry) continue
    if (field.ref.kind === "value") {
      entry.shownText ??= {}
      entry.shownText[pathKey(field.ref.path)] = value
    } else if (field.ref.kind === "comment") {
      entry.commentText = value
    }
  }
}

function clearEntryEdits(entry: CustomEntry): void {
  entry.shown = undefined
  entry.shownText = undefined
  entry.faceEdits = undefined
  entry.clearedAttrs = undefined
  entry.commentText = undefined
}

/** Fold every pending field edit into one value (wid-edit.el `widget-value`). */
function applyShownText(entry: CustomEntry, base: unknown, type: CustomType): unknown {
  let value = base
  for (const [key, text] of Object.entries(entry.shownText ?? {})) {
    const path = key === "" ? [] : key.split("\u0000").map(step =>
      step === "key" || step === "value" ? step : Number(step)) as ValuePath
    const target = typeAtPath(type, path, value) ?? "sexp"
    value = setAtPath(value, path, parseValue(target, text))
  }
  return value
}

function editedValue(entry: CustomEntry, variable: CustomVariable): unknown {
  return applyShownText(entry, shownValue(entry, variable), entryType(entry, variable))
}

/** cus-edit.el `:hidden-states '(standard)` plus the `:custom-show` rule:
 *  only widgets that print inline (booleans, choices) render expanded. */
function entryHidden(entry: CustomEntry, spec: CustomBufferSpec): boolean {
  if (spec.single) return false
  if (entry.hidden != null) return entry.hidden
  if (entry.kind === "group") return false
  if (entry.kind === "icon") return iconDisplayState(entry) === "standard"
  if (entry.kind === "face") return faceDisplayState(entry) === "standard"
  const variable = getCustomVariable(entry.name)
  if (!variable) return true
  const state = variableDisplayState(entry, variable)
  if (state === "standard") return true
  return !widgetShowsInline(variable.type)
}

function variableState(variable: CustomVariable): CustomState {
  if (variable.patched) return "changed"
  if (variable.customized && variable.savedValue !== undefined && deepEqual(variable.value, variable.savedValue)) return "saved"
  if (variable.customized) return "set"
  return "standard"
}

function variableDisplayState(entry: CustomEntry, variable: CustomVariable): CustomState {
  if (entryHasPendingEdits(entry, variable)) return "modified"
  return variableState(variable)
}

function entryHasPendingEdits(entry: CustomEntry, variable: CustomVariable): boolean {
  if (entry.shown !== undefined && !deepEqual(entry.shown, variable.value)) return true
  if (!entry.shownText) return false
  return !deepEqual(editedValue(entry, variable), variable.value)
}

function faceState(name: string): CustomState {
  const face = getCustomFace(name)
  if (!face?.customized) return "standard"
  return faceIsUnsaved(name) ? "set" : "saved"
}

function faceDisplayState(entry: CustomEntry): CustomState {
  if (faceEditsPending(entry)) return "modified"
  return faceState(entry.name)
}

function faceEditsPending(entry: CustomEntry): boolean {
  if (entry.clearedAttrs?.length) return true
  const style = getCustomFace(entry.name)?.spec ?? {}
  const edits = collectFaceEdits(entry)
  for (const [key, value] of Object.entries(edits)) {
    if (!deepEqual(value, faceAttributeToWidget(style, key as FaceAttributeKey))) return true
  }
  return false
}

/** Every pending attribute edit: the staged `faceEdits` plus whatever text is
 *  currently typed into the buffer's fields (`shownText`, rooted at `attr`). */
function collectFaceEdits(entry: CustomEntry): Partial<Record<FaceAttributeKey, unknown>> {
  const edits: Partial<Record<FaceAttributeKey, unknown>> = { ...entry.faceEdits }
  for (const [key, text] of Object.entries(entry.shownText ?? {})) {
    const path = decodePath(key)
    if (path[0] !== "attr") continue
    const attr = path[1] as FaceAttributeKey
    const attrSpec = FACE_ATTRIBUTE_SPECS.find(candidate => candidate.key === attr)
    if (!attrSpec) continue
    const base = edits[attr] !== undefined ? edits[attr] : attrSpec.defaultValue
    const rest = path.slice(2)
    const target = typeAtPath(attrSpec.type, rest, base) ?? "sexp"
    let parsed: unknown
    try { parsed = parseValue(target, text) } catch { parsed = text }
    edits[attr] = rest.length ? setAtPath(base, rest, parsed) : parsed
  }
  return edits
}

/** `pathKey`'s inverse. */
function decodePath(key: string): ValuePath {
  if (key === "") return []
  return key.split("\u0000").map(step =>
    step === "key" || step === "value" || step === "attr" || Number.isNaN(Number(step))
      ? step
      : Number(step)) as ValuePath
}

function groupDisplayState(group: string): CustomState {
  const states = groupMembers(group).entries.map(member =>
    member.kind === "variable"
      ? variableState(getCustomVariable(member.name)!)
      : faceState(member.name))
  for (const [state] of CUSTOM_MAGIC) {
    if (state !== "standard" && states.includes(state)) return state
  }
  return "standard"
}

function magicText(state: CustomState, group: boolean): string {
  const entry = CUSTOM_MAGIC.find(([name]) => name === state)
  if (!entry) return "UNKNOWN."
  return group ? entry[2] : entry[1]
}

// ---------------------------------------------------------------------------
// Widget dispatch
// ---------------------------------------------------------------------------

function widgetAtPoint(buffer: BufferModel): CustomWidget | undefined {
  const point = buffer.point
  const widgets = bufferWidgets(buffer)
  const direct = widgets.find(w => point >= w.start && point < w.end)
  if (direct) return direct
  // cus-edit.el falls back to the button at the beginning of the line.
  const lineStart = buffer.lineBoundsAt().start
  return widgets.find(w => w.start === lineStart)
}

async function invokeWidgetAtPoint(editor: Editor): Promise<void> {
  const buffer = editor.currentBuffer
  if (buffer.locals.get(CUSTOMIZE_THEME_KEY)) return void await invokeThemeWidget(editor)
  if (buffer.locals.get(CUSTOM_BROWSE_KEY)) return void await invokeBrowseWidget(editor)
  if (buffer.locals.get(CUSTOM_NEW_THEME_KEY)) return void await invokeNewThemeWidget(editor)
  if (buffer.locals.get(CUSTOM_DIRLOCALS_KEY)) return void await invokeDirlocalsWidget(editor)
  const spec = bufferSpec(buffer)
  const widget = widgetAtPoint(buffer)
  if (!spec || !widget) throw new Error("You can't edit this part of the Custom buffer")
  captureFieldEdits(buffer)
  const action = widget.action
  switch (action.type) {
    case "manual":
      await editor.run("Custom-help")
      return
    case "search": {
      const pattern = (spec.searchText ?? "").trim()
      if (!pattern) return void editor.message("Enter a search pattern in the search field")
      await editor.run("customize-apropos", [pattern])
      return
    }
    case "revert-menu":
      await revertMenu(editor)
      return
    case "apply":
      await editor.run("Custom-set")
      return
    case "apply-and-save":
      await editor.run("Custom-save")
      return
    case "visibility": {
      const entry = specEntry(spec, action.entry)
      if (!entry) return
      entry.hidden = !entryHidden(entry, spec)
      renderCustomBuffer(editor, spec, { focus: entry.name })
      return
    }
    case "doc": {
      const entry = specEntry(spec, action.entry)
      if (!entry) return
      entry.docShown = !entry.docShown
      renderCustomBuffer(editor, spec, { focus: entry.name })
      return
    }
    case "toggle": {
      const entry = specEntry(spec, action.entry)
      const variable = entry && getCustomVariable(entry.name)
      if (!entry || !variable) return
      const value = editedValue(entry, variable)
      stageValue(entry, variable, setAtPath(value, action.path, !getAtPath(value, action.path)))
      renderCustomBuffer(editor, spec, { focus: entry.name })
      editor.message("To install your edits, invoke [State] and choose the Set operation")
      return
    }
    case "value-menu": {
      const entry = specEntry(spec, action.entry)
      if (!entry) return
      await valueMenu(editor, spec, entry, action.path)
      return
    }
    case "set-checkbox": {
      const entry = specEntry(spec, action.entry)
      const variable = entry && getCustomVariable(entry.name)
      if (!entry || !variable) return
      const value = editedValue(entry, variable)
      const type = typeAtPath(entryType(entry, variable), action.path, value)
      if (!type || !isCompositeType(type) || type.kind !== "set") return
      const option = type.options[action.option]
      if (!option || !("const" in option)) return
      const list = (getAtPath(value, action.path) as unknown[] | undefined) ?? []
      const present = list.some(item => deepEqual(item, option.const))
      const next = present ? list.filter(item => !deepEqual(item, option.const)) : [...list, option.const]
      stageValue(entry, variable, setAtPath(value, action.path, next))
      renderCustomBuffer(editor, spec, { focus: entry.name })
      return
    }
    case "insert": {
      const entry = specEntry(spec, action.entry)
      if (!entry) return
      const value = entryWidgetValue(entry)
      const type = typeAtPath(entryWidgetType(entry), action.path, value)
      const list = [...((getAtPath(value, action.path) as unknown[] | undefined) ?? [])]
      list.splice(action.index, 0, newElementValue(type))
      stageEntryValue(entry, setAtPath(value, action.path, list))
      renderCustomBuffer(editor, spec, { focus: entry.name })
      return
    }
    case "delete": {
      const entry = specEntry(spec, action.entry)
      if (!entry) return
      const value = entryWidgetValue(entry)
      const list = [...((getAtPath(value, action.path) as unknown[] | undefined) ?? [])]
      list.splice(action.index, 1)
      stageEntryValue(entry, setAtPath(value, action.path, list))
      renderCustomBuffer(editor, spec, { focus: entry.name })
      return
    }
    case "state": {
      const entry = specEntry(spec, action.entry)
      if (!entry) return
      await stateMenu(editor, spec, entry)
      return
    }
    case "group-link":
      await editor.run("customize-group", [action.group])
      return
    case "face-link":
      await editor.run("customize-face", [action.face])
      return
    case "attr-checkbox": {
      const entry = specEntry(spec, action.entry)
      if (!entry) return
      const style = faceStyleFor(editor, entry)
      const cleared = entry.clearedAttrs ?? []
      if (faceAttributeIsSetOn(entry, style, action.attr)) {
        // Unchecking stages the attribute for removal on the next Set/Save.
        entry.clearedAttrs = [...cleared, action.attr]
        if (entry.faceEdits) delete entry.faceEdits[action.attr]
      } else {
        entry.clearedAttrs = cleared.filter(attr => attr !== action.attr)
        const attrSpec = FACE_ATTRIBUTE_SPECS.find(candidate => candidate.key === action.attr)
        entry.faceEdits ??= {}
        entry.faceEdits[action.attr] ??= attrSpec?.defaultValue
      }
      entry.showAllAttributes = true
      renderCustomBuffer(editor, spec, { focus: entry.name })
      return
    }
    case "show-all-attributes": {
      const entry = specEntry(spec, action.entry)
      if (!entry) return
      entry.showAllAttributes = !entry.showAllAttributes
      renderCustomBuffer(editor, spec, { focus: entry.name })
      return
    }
    case "field":
      await editor.run("widget-field-activate")
      return
  }
}

/** Stage an edited value on the entry, dropping now-stale per-field text. */
function stageValue(entry: CustomEntry, variable: CustomVariable, value: unknown): void {
  entry.shown = value
  entry.shownText = undefined
  void variable
}

/** The widget type an entry's value is drawn with: an option's own `:type`,
 *  or the fixed `custom-icon` type. */
function entryWidgetType(entry: CustomEntry): CustomType {
  if (entry.kind === "icon") return ICON_TYPE
  // A face's "value" is the `{ attr: { KEY: … } }` record its rows address,
  // so its type is a `list` of one member per attribute, keyed by name.
  if (entry.kind === "face") return FACE_WIDGET_TYPE
  const variable = getCustomVariable(entry.name)
  return variable ? entryType(entry, variable) : "sexp"
}

/** The entry's current widget value, including any pending field edits. */
function entryWidgetValue(entry: CustomEntry): unknown {
  if (entry.kind === "icon") return applyShownText(entry, iconWidgetValue(entry), ICON_TYPE)
  if (entry.kind === "face") return { attr: collectFaceEdits(entry) }
  const variable = getCustomVariable(entry.name)
  return variable ? editedValue(entry, variable) : undefined
}

function stageEntryValue(entry: CustomEntry, value: unknown): void {
  if (entry.kind === "face") {
    // A face's staged value is the `attr` record itself.
    const attrs = (value as { attr?: Record<string, unknown> } | undefined)?.attr ?? {}
    entry.faceEdits = { ...attrs } as Partial<Record<FaceAttributeKey, unknown>>
    entry.shownText = undefined
    return
  }
  entry.shown = value
  entry.shownText = undefined
}

function newElementValue(type: CustomType | undefined): unknown {
  if (!type || !isCompositeType(type)) return ""
  switch (type.kind) {
    case "repeat": return defaultValue(type.item)
    case "hook": return ""
    case "alist": return [defaultValue(type.key), defaultValue(type.value)]
    default: return ""
  }
}

/** wid-edit.el `[Value Menu]`: pick which `choice` arm the value uses. */
async function valueMenu(
  editor: Editor,
  spec: CustomBufferSpec,
  entry: CustomEntry,
  path: ValuePath,
): Promise<void> {
  const value = entryWidgetValue(entry)
  const type = typeAtPath(entryWidgetType(entry), path, value)
  if (!type || !isCompositeType(type) || type.kind !== "choice") return
  const labels = type.options.map(choiceLabel)
  const choice = await editor.completingRead(`${customTypeLabel(type)}: `, {
    collection: labels,
    history: "custom-value-menu",
  })
  if (!choice) return
  const option = type.options[labels.indexOf(choice)]
  if (!option) return
  const next = "const" in option ? option.const : defaultValue(option.type)
  stageEntryValue(entry, setAtPath(value, path, next))
  renderCustomBuffer(editor, spec, { focus: entry.name })
}

/** cus-edit.el `custom-reset-extended-menu`, filtered by the current state. */
async function revertMenu(editor: Editor): Promise<void> {
  const spec = bufferSpec(editor.currentBuffer)
  const states = spec ? specApplyEntries(spec).map(entry => entryState(entry)) : []
  const items: Array<[string, string]> = []
  if (states.includes("modified")) items.push(["Undo Edits in Customization Buffer", "Custom-reset-current"])
  if (states.some(state => ["modified", "set", "changed", "rogue"].includes(state))) {
    items.push(["Revert This Session's Customizations", "Custom-reset-saved"])
  }
  if (states.some(state => ["modified", "set", "changed", "rogue", "saved"].includes(state))) {
    items.push(["Erase Customizations", "Custom-reset-standard"])
  }
  if (!items.length) return void editor.message("No settings to reset")
  const choice = await editor.completingRead("Reset settings: ", {
    collection: items.map(([label]) => label),
    history: "custom-reset",
  })
  const command = items.find(([label]) => label === choice)?.[1]
  if (command) await editor.run(command)
}

function entryState(entry: CustomEntry): CustomState {
  if (entry.kind === "face") return faceDisplayState(entry)
  if (entry.kind === "icon") return iconDisplayState(entry)
  if (entry.kind === "group") return groupDisplayState(entry.name)
  const variable = getCustomVariable(entry.name)
  return variable ? variableDisplayState(entry, variable) : "standard"
}

/** cus-edit.el `custom-variable-extended-menu` / `custom-face-extended-menu` /
 *  `custom-group-extended-menu`, filtered by the widget's current state exactly
 *  as `widget--simplify-menu` does: disabled items and the selected radio
 *  button are dropped, so the menu shrinks as the setting changes state. */
async function stateMenu(editor: Editor, spec: CustomBufferSpec, entry: CustomEntry): Promise<void> {
  const state = entryState(entry)
  const items: Array<[string, () => Promise<void> | void]> = []
  const has = (...states: CustomState[]) => states.includes(state)
  const set = () => void applyEntry(editor, entry, "set")
  const save = async () => { await applyEntry(editor, entry, "save"); await saveCustomFile() }
  const undo = () => clearEntryEdits(entry)
  const revert = () => void applyEntry(editor, entry, "reset-saved")
  const erase = async () => { await applyEntry(editor, entry, "reset-standard"); await saveCustomFile() }
  const comment = () => { entry.commentShown = true }

  if (entry.kind === "group") {
    // `custom-group-extended-menu`: every item is gated on the group's state.
    if (has("modified")) items.push(["Set for Current Session", set])
    if (has("modified", "set")) items.push(["Save for Future Sessions", save])
    if (has("modified")) items.push(["Undo Edits", undo])
    if (has("modified", "set")) items.push(["Revert This Session's Customizations", revert])
    if (has("modified", "set", "saved")) items.push(["Erase Customization", erase])
  } else if (entry.kind === "face") {
    // `custom-face-extended-menu`: Set/Save carry no :enable form, and Erase is
    // gated on the face having a defface spec, which every jemacs face has.
    items.push(["Set for Current Session", set])
    items.push(["Save for Future Sessions", save])
    if (has("modified", "changed")) items.push(["Undo Edits", undo])
    if (has("modified", "set", "changed")) items.push(["Revert This Session's Customization", revert])
    items.push(["Erase Customization", erase])
    if (!entry.commentShown) items.push(["Add Comment", comment])
    // Three radio buttons for `custom-form'; the selected one is filtered out.
    if (entry.form != null && entry.form !== "edit") items.push(["For Current Display", () => setForm(entry, "edit")])
    if (entry.form !== "all") items.push(["For All Kinds of Displays", () => setForm(entry, "all")])
    if (entry.form !== "lisp") items.push(["Show Lisp Expression", () => setForm(entry, "lisp")])
  } else if (entry.kind === "icon") {
    // `custom-icon-extended-menu`.
    if (has("modified")) items.push(["Set for Current Session", set])
    if (has("modified", "set", "changed")) items.push(["Save for Future Sessions", save])
    if (has("modified", "changed")) items.push(["Undo Edits", undo])
    if (has("modified", "set", "changed", "rogue")) items.push(["Revert This Session's Customization", revert])
    if (has("modified", "set", "changed", "saved", "rogue")) items.push(["Erase Customization", erase])
  } else {
    // `custom-variable-extended-menu`.
    if (has("modified")) items.push(["Set for Current Session", set])
    if (has("modified", "set", "changed", "rogue")) items.push(["Save for Future Sessions", save])
    if (has("modified", "changed")) items.push(["Undo Edits", undo])
    if (has("modified", "set", "changed", "rogue")) items.push(["Revert This Session's Customization", revert])
    if (has("modified", "set", "changed", "saved", "rogue")) items.push(["Erase Customization", erase])
    if (!entry.commentShown) items.push(["Add Comment", comment])
    items.push(entry.form === "lisp"
      ? ["Show Current Value", () => setForm(entry, "edit")]
      : ["Show Saved Lisp Expression", () => setForm(entry, "lisp")])
  }
  if (!items.length) return void editor.message(`No operations available for ${unlispifyTagName(entry.name)}`)

  const choice = await editor.completingRead(`Operation on ${unlispifyTagName(entry.name)}: `, {
    collection: items.map(([label]) => label),
    history: "custom-operation",
  })
  const action = items.find(([label]) => label === choice)?.[1]
  if (!action) return
  await action()
  renderCustomBuffer(editor, spec, { focus: entry.name })
}

function setForm(entry: CustomEntry, form: "edit" | "lisp" | "all"): void {
  entry.form = form
  clearEntryEdits(entry)
}

type ApplyOp = "set" | "save" | "reset-current" | "reset-saved" | "reset-standard"

async function applyEntry(editor: Editor, entry: CustomEntry, op: ApplyOp): Promise<boolean> {
  if (entry.kind === "group") return false
  if (entry.kind === "icon") return applyIconEntry(entry, op)
  if (entry.kind === "variable") return applyVariableEntry(editor, entry, op)
  return applyFaceEntry(editor, entry, op)
}

/** cus-edit.el `custom-icon-set` / `-save` / `-reset-*`. */
function applyIconEntry(entry: CustomEntry, op: ApplyOp): boolean {
  switch (op) {
    case "set":
    case "save": {
      const pending = entry.shown !== undefined || entry.shownText != null
      if (pending) setCustomIcon(entry.name, iconSpecsFromWidget(entryWidgetValue(entry)))
      else if (op === "set") return false
      const changed = op === "save" ? saveCustomIcon(entry.name) : true
      clearEntryEdits(entry)
      return changed
    }
    case "reset-current":
      if (entry.shown === undefined && entry.shownText == null) return false
      clearEntryEdits(entry)
      return true
    case "reset-saved":
      clearEntryEdits(entry)
      return resetCustomIconToSaved(entry.name)
    case "reset-standard":
      clearEntryEdits(entry)
      return resetCustomIcon(entry.name)
  }
}

function applyVariableEntry(editor: Editor, entry: CustomEntry, op: ApplyOp): boolean {
  const variable = getCustomVariable(entry.name)
  if (!variable) return false
  switch (op) {
    case "set":
    case "save": {
      const pending = entryHasPendingEdits(entry, variable)
      const commentChanged = entry.commentText != null && entry.commentText !== (variable.comment ?? "")
      if (!pending && op === "set" && !commentChanged) return false
      if (!pending && op === "save" && !variable.customized && !commentChanged) return false
      if (commentChanged) setCustomComment(entry.name, entry.commentText)
      const value = pending ? editedValue(entry, variable) : variable.value
      if (op === "save") saveCustom(entry.name, value)
      else setCustom(entry.name, value)
      clearEntryEdits(entry)
      return true
    }
    case "reset-current":
      if (!entry.shownText && entry.shown === undefined && entry.commentText == null) return false
      clearEntryEdits(entry)
      return true
    case "reset-saved":
      clearEntryEdits(entry)
      return resetCustomToSaved(entry.name)
    case "reset-standard":
      clearEntryEdits(entry)
      return resetCustom(entry.name)
  }
}

function applyFaceEntry(editor: Editor, entry: CustomEntry, op: ApplyOp): boolean {
  switch (op) {
    case "set":
    case "save": {
      let changed = false
      for (const attr of entry.clearedAttrs ?? []) {
        // An attribute row owns more than one FaceStyle key (`:height` is both
        // the absolute and the scaled form), so clear each of them.
        for (const key of faceAttributeKeys(attr)) {
          if (unsetFaceAttribute(entry.name, key)) changed = true
        }
      }
      const style = getCustomFace(entry.name)?.spec ?? {}
      for (const [attr, value] of Object.entries(collectFaceEdits(entry))) {
        const key = attr as FaceAttributeKey
        if (entry.clearedAttrs?.includes(key)) continue
        // Capturing the buffer records every visible field, including the
        // placeholder values `Show All Attributes` puts in unchecked rows.
        // Apply a row only when its checkbox is checked and its value differs
        // from what the face already holds.
        if (!faceAttributeIsSetOn(entry, style, key)) continue
        const attrSpec = FACE_ATTRIBUTE_SPECS.find(candidate => candidate.key === key)
        const shown = faceAttributeIsSet(style, key)
          ? faceAttributeToWidget(style, key)
          : attrSpec?.defaultValue
        if (deepEqual(value, shown) && faceAttributeIsSet(style, key)) continue
        // cus-face.el's "filter to make customized-value suitable for storing".
        for (const [target, stored] of Object.entries(faceAttributeFromWidget(key, value))) {
          if (stored === undefined) unsetFaceAttribute(entry.name, target as FaceAttributeKey)
          else setFaceAttribute(entry.name, target as FaceAttributeKey, stored)
        }
        changed = true
      }
      if (entry.commentText != null && entry.commentText !== (getFaceComment(entry.name) ?? "")) {
        setFaceComment(entry.name, entry.commentText)
        changed = true
      }
      if (op === "save" && (changed || getCustomFace(entry.name)?.customized)) {
        saveFace(entry.name)
        changed = true
      }
      if (changed) {
        clearEntryEdits(entry)
        editor.refreshComposedTheme()
      }
      return changed
    }
    case "reset-current":
      if (!entry.faceEdits && !entry.shownText && !entry.clearedAttrs && entry.commentText == null) return false
      clearEntryEdits(entry)
      return true
    case "reset-saved": {
      clearEntryEdits(entry)
      const ok = resetFaceToSaved(entry.name)
      if (ok) editor.refreshComposedTheme()
      return ok
    }
    case "reset-standard": {
      clearEntryEdits(entry)
      const ok = resetFace(entry.name)
      if (ok) editor.refreshComposedTheme()
      return ok
    }
  }
}

/** cus-edit.el `custom-command-apply`: confirm unless the buffer holds one item. */
async function customCommandApply(editor: Editor, op: ApplyOp, query: string): Promise<void> {
  const buffer = editor.currentBuffer
  const spec = bufferSpec(buffer)
  if (!spec) return void editor.message("Not a Custom buffer")
  captureFieldEdits(buffer)
  if (!spec.single) {
    const answer = await editor.prompt(`${query}(y or n) `, "", "custom-command-apply")
    if (answer?.trim().toLowerCase() !== "y") {
      editor.message("Aborted")
      return
    }
  }
  let changed = 0
  for (const entry of specApplyEntries(spec)) {
    if (await applyEntry(editor, entry, op)) changed++
  }
  if (op === "save" || op === "reset-standard") await saveCustomFile()
  renderCustomBuffer(editor, spec)
  if (op === "set") editor.message(changed ? `Set ${changed} setting${changed === 1 ? "" : "s"}` : "No edited settings")
  else if (op === "save") editor.message(changed ? `Saved ${changed} setting${changed === 1 ? "" : "s"}` : "No settings to save")
}

function setEntryForm(editor: Editor, form: "edit" | "lisp"): void {
  const buffer = editor.currentBuffer
  const spec = bufferSpec(buffer)
  if (!spec) return void editor.message("Not a Custom buffer")
  captureFieldEdits(buffer)
  const name = variableAtPoint(editor)
  const entry = name ? findEntry(spec, name) : undefined
  if (!entry) return void editor.message("No customizable option at point")
  entry.form = form
  clearEntryEdits(entry)
  renderCustomBuffer(editor, spec, { focus: entry.name })
}

function moveWidget(editor: Editor, count: number): void {
  const buffer = editor.currentBuffer
  const stops = buffer.locals.get(CUSTOMIZE_THEME_KEY)
    ? themeWidgetPositions(buffer.text)
    : bufferWidgets(buffer).map(widget => widget.start)
  const sorted = [...new Set(stops)].sort((a, b) => a - b)
  if (!sorted.length) return
  if (count > 0) {
    for (let i = 0; i < count; i++) {
      buffer.point = sorted.find(position => position > buffer.point) ?? sorted[0]!
    }
  } else {
    for (let i = 0; i < -count; i++) {
      buffer.point = [...sorted].reverse().find(position => position < buffer.point) ?? sorted.at(-1)!
    }
  }
}

function focusEntry(buffer: BufferModel, name: string): void {
  const tag = unlispifyTagName(name)
  for (const prefix of ["Hide ", "Show Value ", "Show "]) {
    const index = buffer.text.indexOf(`${prefix}${tag}`)
    if (index >= 0) {
      buffer.point = index
      return
    }
  }
  const bracketed = buffer.text.indexOf(`[${tag}]`)
  if (bracketed >= 0) buffer.point = bracketed
}

export function refreshCustomizeBuffer(editor: Editor, focusName?: string): void {
  const buffer = editor.currentBuffer
  if (buffer.locals.get(CUSTOMIZE_THEME_KEY)) {
    const themes = buffer.locals.get(CUSTOMIZE_THEME_KEY) as string[]
    const title = buffer.locals.get(CUSTOMIZE_TITLE_KEY) as string | undefined
    showCustomizeThemesBuffer(editor, themes, title)
    if (focusName) {
      const row = [...editor.currentBuffer.text.matchAll(THEME_ROW_RE_G)].find(match => match[2] === focusName)
      if (row?.index != null) editor.currentBuffer.point = row.index
    }
    return
  }
  const browse = buffer.locals.get(CUSTOM_BROWSE_KEY) as BrowseState | undefined
  if (browse) return void showBrowseBuffer(editor, browse)
  const theme = newThemeState(buffer)
  if (theme) return void showNewThemeBuffer(editor, theme)
  const dirlocals = dirlocalsState(buffer)
  if (dirlocals) return void renderDirlocals(editor, dirlocals)
  const spec = bufferSpec(buffer)
  if (!spec) return
  captureFieldEdits(buffer)
  renderCustomBuffer(editor, spec, focusName ? { focus: focusName } : {})
}

// ---------------------------------------------------------------------------
// Selection helpers
// ---------------------------------------------------------------------------

function entryAtPoint(editor: Editor, kind: "variable" | "face"): string | null {
  const buffer = editor.currentBuffer
  const spec = bufferSpec(buffer)
  if (!spec) return null
  const widget = widgetAtPoint(buffer)
  const index = widget && "entry" in widget.action ? widget.action.entry
    : widget?.action.type === "field" && "entry" in widget.action.ref ? widget.action.ref.entry
      : null
  if (index != null) {
    const entry = specEntry(spec, index)
    if (entry?.kind === kind) return entry.name
  }
  // Fall back to the entry whose heading last precedes point.
  const entries = specApplyEntries(spec).filter(entry => entry.kind === kind)
  const before = buffer.text.slice(0, buffer.point)
  const candidates = entries
    .map(entry => ({ entry, at: before.lastIndexOf(unlispifyTagName(entry.name)) }))
    .filter(candidate => candidate.at >= 0)
    .sort((a, b) => a.at - b.at)
  return candidates.at(-1)?.entry.name ?? entries[0]?.name ?? null
}

function variableAtPoint(editor: Editor): string | null {
  return entryAtPoint(editor, "variable")
}

function faceAtPoint(editor: Editor): string | null {
  return entryAtPoint(editor, "face")
}

export function customizeThemeAtPoint(editor: Editor): string | null {
  if (!editor.currentBuffer.locals.get(CUSTOMIZE_THEME_KEY)) return null
  const line = editor.currentBuffer.lineBoundsAt().text
  const direct = THEME_ROW_RE.exec(line)?.[2]
  if (direct && getBuiltinTheme(direct)) return direct

  const before = editor.currentBuffer.text.slice(0, editor.currentBuffer.point)
  const name = [...before.matchAll(THEME_ROW_RE_G)].at(-1)?.[2]
  return name && getBuiltinTheme(name) ? name : null
}

// ---------------------------------------------------------------------------
// Direct setters (M-x customize-set-variable etc.)
// ---------------------------------------------------------------------------

/** The three cus-edit.el setters: `customize-set-value` (plain set),
 *  `customize-set-variable` (a Customize customization), and
 *  `customize-save-variable` (customize, then write the custom file). */
type SetterKind = "set-value" | "set" | "save"

async function customizeSetVariable(editor: Editor, args: string[], kind: SetterKind, withComment = false): Promise<void> {
  // cus-edit.el's `custom-prompt-variable' always reads the variable; unlike
  // the Custom-* buffer commands, these setters never take it from point.
  const name = args[0] ?? await editor.completingRead(kind === "save" ? "Set and save variable: " : "Set variable: ", {
    collection: listCustomVariables().map(variable => variable.name),
    history: "variable",
  })
  if (!name) return
  const variable = getCustomVariable(name)
  if (!variable) {
    editor.message(`No user option named ${name}`)
    return
  }
  // cus-edit.el's three prompts, verbatim.
  const prompt = kind === "save" ? `Set and save value for ${name} as: `
    : kind === "set" ? `Set customized value for ${name} to: `
      : `Set ${name} to value: `
  const raw = args.length >= 2
    ? args[1]!
    : await editor.prompt(prompt, formatValue(variable.type, variable.value), `customize-${name}`)
  if (raw == null) return
  const value = parseValue(variable.type, raw)
  // cus-edit.el takes COMMENT as a third argument, and prompts for it when
  // called with a prefix argument.
  if (withComment || args.length >= 3) {
    const comment = args[2] ?? await editor.prompt("Comment: ", variable.comment ?? "", "custom-comment")
    // `customize-set-value` sets `variable-comment` only; the Customize setters
    // also record it as a customization, which `setCustomComment` does.
    if (comment != null) setCustomComment(name, comment, kind !== "set-value")
  }
  if (kind === "save") {
    saveCustom(name, value)
    await saveCustomFile()
    editor.message(`Saved ${name}`)
  } else if (kind === "set") {
    setCustom(name, value)
    editor.message(`Set ${name}`)
  } else {
    setCustomValue(name, value)
    editor.message(`Set ${name}`)
  }
  refreshCustomizeBuffer(editor, name)
}

async function customizeSetFace(editor: Editor, args: string[], save: boolean): Promise<void> {
  const name = args[0] ?? await editor.completingRead("Customize face: ", {
    collection: listKnownFaceNames(),
    history: "customize-face",
  })
  if (!name) return
  const keys = FACE_ATTRIBUTE_SPECS.map(attrSpec => attrSpec.key)
  const attribute = (args[1] ?? await editor.completingRead("Face attribute: ", {
    collection: keys,
    history: "face-attribute",
  })) as FaceAttributeKey | null
  const attrSpec = attribute ? FACE_ATTRIBUTE_SPECS.find(candidate => candidate.key === attribute) : undefined
  if (!attribute || !attrSpec) {
    editor.message("No face attribute specified")
    return
  }
  const style = resolveThemeFace(editor.theme, name as FaceName) ?? {}
  const current = faceAttributeToWidget(style, attribute)
  const raw = args[2] ?? await editor.prompt(
    `Set ${name} ${attribute}: `,
    current == null ? "" : formatValue(attrSpec.type, current),
    `customize-face-${name}-${attribute}`,
  )
  if (raw == null) return
  for (const [target, stored] of Object.entries(faceAttributeFromWidget(attribute, parseValue(attrSpec.type, raw)))) {
    if (stored === undefined) unsetFaceAttribute(name, target as FaceAttributeKey)
    else setFaceAttribute(name, target as FaceAttributeKey, stored)
  }
  if (save) {
    saveFace(name)
    await saveCustomFile()
    editor.message(`Saved ${name} ${attribute}`)
  } else {
    editor.message(`Set ${name} ${attribute}`)
  }
  editor.refreshComposedTheme()
  refreshCustomizeBuffer(editor, name)
}

async function customizeApropos(editor: Editor, args: string[], type: "all" | "options" | "groups" | "faces"): Promise<void> {
  const pattern = args[0] ?? await editor.prompt("Customize apropos: ", "", "customize-apropos")
  if (!pattern) return
  const re = new RegExp(pattern, "i")
  const entries: CustomEntry[] = []
  if (type === "all" || type === "groups") {
    for (const group of listCustomGroups()) {
      if (re.test(group.name)) entries.push({ kind: "group", name: group.name })
    }
  }
  if (type === "all" || type === "faces") {
    for (const face of listKnownFaceNames()) {
      if (re.test(face)) entries.push({ kind: "face", name: face })
    }
  }
  if (type === "all" || type === "options") {
    for (const variable of listCustomVariables()) {
      if (re.test(variable.name)) entries.push({ kind: "variable", name: variable.name })
    }
  }
  if (!entries.length) {
    const what = type === "all" ? "group, face, or option" : type.replace(/s$/, "")
    throw new Error(`No customizable ${what} matching ${pattern}`)
  }
  showCustomBuffer(editor, {
    bufferName: "*Customize Apropos*",
    entries,
    single: false,
    searchText: pattern,
  })
}

function unsavedEntries(): CustomEntry[] {
  return [
    ...listKnownFaceNames().filter(name => faceIsUnsaved(name))
      .map((name): CustomEntry => ({ kind: "face", name })),
    ...listCustomVariables().filter(isUnsavedCustom)
      .map((variable): CustomEntry => ({ kind: "variable", name: variable.name })),
  ]
}

function isUnsavedCustom(variable: CustomVariable): boolean {
  if (!variable.customized) return false
  if (variable.savedValue === undefined) return true
  return !deepEqual(variable.value, variable.savedValue)
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

async function readGroup(editor: Editor): Promise<string | null> {
  const group = await editor.completingRead("Customize group: ", {
    collection: customizeGroupNames(),
    history: "customize-group",
    initialValue: TOP_CUSTOM_GROUP,
  })
  return group ? lispifyTagName(group) : null
}

function showGroupBuffer(editor: Editor, group: string): void {
  const name = getCustomGroup(group) ? group : TOP_CUSTOM_GROUP
  showCustomBuffer(editor, {
    // cus-edit.el names the buffer after the group's tag, so `comm` opens as
    // "*Customize Group: Communication*".
    bufferName: `*Customize Group: ${groupTag(name)}*`,
    entries: [{ kind: "group", name }],
    single: true,
  })
}

function groupMembers(group: string, sortedOverride?: boolean): {
  entries: Array<{ kind: "variable" | "face"; name: string }>
  subgroups: Array<{ name: string; doc?: string }>
} {
  // cus-edit.el: "Never sort the top-level custom group", so `emacs` lists its
  // members in declaration order and every other group sorts alphabetically.
  const sorted = group === TOP_CUSTOM_GROUP
    ? false
    : sortedOverride ?? getCustom<boolean>("custom-buffer-sort-alphabetically") ?? true
  const variables = listCustomVariables()
    .filter(variable => variable.group === group)
    .map(variable => ({ kind: "variable" as const, name: variable.name }))
  const faces = listKnownFaceNames()
    .filter(name => getCustomFace(name)?.group === group)
    .map(name => ({ kind: "face" as const, name }))
  const entries = [...variables, ...faces]
  if (sorted) entries.sort((a, b) => a.name.localeCompare(b.name))
  // `(get SYMBOL 'custom-group)` is an ordered list; keep that order, then
  // sort only when this group sorts.
  const children = customGroupChildren(group).filter(name => name !== group)
  const subgroups = children.map(name => ({ name, doc: getCustomGroup(name)?.doc }))
  if (sorted) subgroups.sort((a, b) => a.name.localeCompare(b.name))
  return { entries, subgroups }
}

function customizeGroupNames(): string[] {
  return listCustomGroups().map(group => group.name)
}

/** `customize-mode` completes over mode names, not group names. */
function modeGroupCandidates(): string[] {
  return [...new Set([
    ...listCustomGroups().map(group => group.name),
    ...listCustomGroups().map(group => `${group.name}-mode`),
  ])].sort()
}

function groupForMode(mode: string): string {
  if (getCustomGroup(mode)) return mode
  const base = mode.endsWith("-mode") ? mode.slice(0, -"-mode".length) : mode
  return getCustomGroup(base) ? base : TOP_CUSTOM_GROUP
}

// ---------------------------------------------------------------------------
// *Customize Browser* (custom-browse-mode)
// ---------------------------------------------------------------------------

/** cus-edit.el's tree browser. Each group line is `PREFIX[+]-- [Group] Tag`;
 *  leaves are `PREFIX|--- [Option] Tag` / `` `--- ``  for the last child. */
function showBrowseBuffer(editor: Editor, state: BrowseState): void {
  const root = getCustomGroup(state.root) ? state.root : TOP_CUSTOM_GROUP
  state.root = root
  const render = new CustomRender()
  render.text([
    "Square brackets indicate buttons; type RET or click mouse-1",
    "on a button to invoke its action.",
    "Invoke [+] to expand a group, and [-] to collapse an expanded group.",
    "Invoke the [Group], [Face], and [Option] buttons below to edit that",
    "item in another window.",
    "",
    "",
  ].join("\n"))
  // cus-edit.el starts the root with `:custom-last t`, so its children are
  // indented with "   " rather than " | ".
  renderBrowseGroup(render, state, root, "", true)
  render.finish()
  const body = render.build()
  const buffer = editor.scratch("*Customize Browser*", body, "customize-browse-mode")
  buffer.readOnly = true
  buffer.setEditableFields(null)
  buffer.locals.set(CUSTOM_BROWSE_KEY, state)
  buffer.locals.set(CUSTOM_WIDGETS_KEY, render.widgets)
  buffer.locals.set(CUSTOM_FIELDS_KEY, [])
  buffer.locals.set(CUSTOM_SPANS_KEY, render.spans)
  buffer.locals.delete(CUSTOM_SPEC_KEY)
  buffer.locals.delete(CUSTOMIZE_THEME_KEY)
  buffer.locals.set(REVERT_BUFFER_FUNCTION_KEY, "customize-refresh")
  buffer.point = 0
}

/** One node of the browser tree. PREFIX is the indentation cus-edit.el built
 *  for this level; LAST says whether this node is its parent's final child,
 *  which decides whether its own children are indented `"   "` or `" | "`. */
function renderBrowseGroup(render: CustomRender, state: BrowseState, group: string, prefix: string, last: boolean): void {
  const expanded = state.expanded.has(group)
  // The browser has its own sort option (`custom-browse-sort-alphabetically').
  const members = groupMembers(group, getCustom<boolean>("custom-browse-sort-alphabetically") ?? false)
  const items: Array<{ kind: "group" | "variable" | "face"; name: string }> = [
    // `custom-browse-order-groups' defaults to `first'.
    ...members.subgroups.map(sub => ({ kind: "group" as const, name: sub.name })),
    ...members.entries,
  ]
  render.text(prefix)
  if (!items.length) render.text("[ ]-- ")
  else {
    render.button(expanded ? "[-]" : "[+]", { type: "browse-toggle", group })
    render.text(expanded ? "-\\ " : "-- ")
  }
  render.button("[Group]", { type: "browse-visit", kind: "group", name: group })
  render.text(` ${unlispifyTagName(group)}`)
  render.nl()
  if (!expanded || !items.length) return

  const childPrefix = `${prefix}${last ? "   " : " | "}`
  items.forEach((item, index) => {
    const isLast = index === items.length - 1
    if (item.kind === "group") {
      renderBrowseGroup(render, state, item.name, childPrefix, isLast)
      return
    }
    render.text(`${childPrefix}${isLast ? " `--- " : " |--- "}`)
    render.button(item.kind === "variable" ? "[Option]" : "[Face]",
      { type: "browse-visit", kind: item.kind, name: item.name })
    render.text(` ${unlispifyTagName(item.name)}`)
    render.nl()
  })
}

async function invokeBrowseWidget(editor: Editor): Promise<void> {
  const buffer = editor.currentBuffer
  const state = buffer.locals.get(CUSTOM_BROWSE_KEY) as BrowseState
  const widget = widgetAtPoint(buffer)
  if (!widget) return void editor.message("No widget at point")
  if (widget.action.type === "browse-toggle") {
    const group = widget.action.group
    if (state.expanded.has(group)) state.expanded.delete(group)
    else state.expanded.add(group)
    const point = buffer.point
    showBrowseBuffer(editor, state)
    editor.currentBuffer.point = Math.min(point, editor.currentBuffer.text.length)
    return
  }
  if (widget.action.type === "browse-visit") {
    const { kind, name } = widget.action
    // cus-edit.el: browser buttons edit the item in *another* window.
    if (kind === "group") await editor.run("customize-group-other-window", [name])
    else if (kind === "variable") await editor.run("customize-variable-other-window", [name])
    else await editor.run("customize-face-other-window", [name])
    return
  }
  editor.message("No widget at point")
}

// ---------------------------------------------------------------------------
// Themes (cus-theme.el)
// ---------------------------------------------------------------------------

async function invokeThemeWidget(editor: Editor): Promise<void> {
  const line = editor.currentBuffer.lineBoundsAt().text
  if (line.startsWith(THEME_SAVE_BUTTON)) return void await editor.run("custom-theme-save")
  if (line.endsWith(THEME_MULTIPLE_LABEL)) return void await editor.run("custom-theme-selections-toggle")
  if (line.includes(THEME_MIGRATE_BUTTON)) return void await editor.run("customize-create-theme", ["user"])
  if (customizeThemeAtPoint(editor)) return void await editor.run("custom-theme-checkbox-toggle")
  editor.message("No widget at point")
}

/** Offsets `widget-forward` stops at in the theme chooser, in document order:
 *  the `here` migrate link, the save button, the multi-select checkbox, then
 *  every `[X][ name]` theme checkbox. */
function themeWidgetPositions(text: string): number[] {
  const positions: number[] = []
  const migrate = text.indexOf(THEME_MIGRATE_BUTTON)
  if (migrate >= 0) positions.push(migrate)
  const save = text.indexOf(THEME_SAVE_BUTTON)
  if (save >= 0) positions.push(save)
  const multiple = text.indexOf(`] ${THEME_MULTIPLE_LABEL}`)
  if (multiple >= 0) positions.push(text.lastIndexOf("\n", multiple) + 1)
  for (const match of text.matchAll(THEME_ROW_RE_G)) positions.push(match.index ?? 0)
  return positions
}

function showCustomizeThemesBuffer(editor: Editor, themeNames = listBuiltinThemeNames(), title?: string): void {
  // cus-theme.el makes `custom-theme-allow-multiple-selections' buffer-local and
  // force-enables it when more than one theme is already active.
  if (listEnabledBuiltinThemes().length > 1) setCustom("custom-theme-allow-multiple-selections", true)
  const body = formatCustomizeThemesBuffer(themeNames, title)
  const buffer = editor.scratch("*Custom Themes*", body, "custom-theme-choose-mode")
  buffer.readOnly = true
  buffer.setEditableFields(null)
  buffer.locals.set(REVERT_BUFFER_FUNCTION_KEY, "custom-theme-choose-revert")
  buffer.locals.set(CUSTOMIZE_THEME_KEY, themeNames)
  buffer.locals.delete(CUSTOMIZE_VARIABLE_KEY)
  buffer.locals.delete(CUSTOM_SPEC_KEY)
  buffer.locals.delete(CUSTOM_BROWSE_KEY)
  buffer.locals.delete(CUSTOM_NEW_THEME_KEY)
  if (title) buffer.locals.set(CUSTOMIZE_TITLE_KEY, title)
  else buffer.locals.delete(CUSTOMIZE_TITLE_KEY)
  buffer.point = 0
}

/** Text layout of `customize-themes` in cus-theme.el, minus mouse widgets. */
function formatCustomizeThemesBuffer(themeNames: string[], title?: string): string {
  const enabled = new Set(listEnabledBuiltinThemes())
  const multiple = getCustom<boolean>("custom-theme-allow-multiple-selections") ?? false
  const lines: string[] = []
  if (title) lines.push(title, "")
  lines.push(
    "Type RET or click to enable/disable listed custom themes.",
    "Type ? to describe the theme at point.",
    "Themes are registered by plugins and built-ins.",
    "",
  )
  // cus-theme.el prints the Note only when `user' has theme-settings beyond
  // `custom-enabled-themes' — i.e. the user customized some option or face.
  if (hasUserCustomizations()) {
    lines.push(
      " Note: Your custom settings take precedence over theme settings.",
      `       To migrate your settings into a theme, click ${THEME_MIGRATE_BUTTON}.`,
      "",
    )
  }
  lines.push(
    THEME_SAVE_BUTTON,
    `[${multiple ? "X" : " "}] ${THEME_MULTIPLE_LABEL}`,
    "",
    "Available Custom Themes:",
  )
  if (!themeNames.length) {
    lines.push("No Custom themes match.")
    return lines.join("\n")
  }
  for (const name of themeNames) {
    lines.push(`[${enabled.has(name) ? "X" : " "}][ ${name}] -- ${themeSummary(name)}`)
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// *Custom Theme* (custom-new-theme-mode)
// ---------------------------------------------------------------------------

function newThemeState(buffer: BufferModel): NewThemeState | undefined {
  return buffer.locals.get(CUSTOM_NEW_THEME_KEY) as NewThemeState | undefined
}

function newThemeStateFor(name: string): NewThemeState {
  const date = new Date().toISOString().slice(0, 10)
  return {
    themeName: name === "user" ? "" : name,
    description: `Created ${date}.`,
    faces: getCustomizedFaceOverrides().map(face => face.name),
    variables: listCustomVariables()
      .filter(variable => variable.customized && !CHOOSER_OWNED_OPTIONS.has(variable.name))
      .map(variable => variable.name),
    removeSaved: true,
  }
}

/** cus-theme.el `customize-create-theme` layout. */
function showNewThemeBuffer(editor: Editor, state: NewThemeState): void {
  const render = new CustomRender()
  render.text([
    "This buffer contains all the Custom settings you have made.",
    "You can convert them into a new custom theme, and optionally",
    "remove them from your saved Custom file.",
    "",
    "",
  ].join("\n"))
  render.button("[ Visit Theme ]", { type: "new-theme", action: "visit" })
  render.text("  ")
  render.button("[ Merge Theme ]", { type: "new-theme", action: "merge" })
  render.text("  ")
  render.button("[ Revert ]", { type: "new-theme", action: "revert" })
  render.nl()
  render.nl()
  render.text("Theme name : ")
  render.field(state.themeName, { kind: "theme-name" })
  render.nl()
  render.text("Description: ")
  render.field(state.description, { kind: "theme-description" })
  render.nl()
  render.button("[ Save Theme ]", { type: "new-theme", action: "save" })
  render.text("  ")
  render.button(`[${state.removeSaved ? "X" : " "}]`, { type: "new-theme", action: "remove-saved" })
  render.text(" Remove saved theme settings from Custom save file.")
  render.nl()
  render.nl()
  render.text("  Theme faces:")
  render.nl()
  for (const face of state.faces) {
    render.text("  ")
    render.button(`[${unlispifyTagName(face)}]`, { type: "face-link", face })
    render.text(`: ${JSON.stringify(getCustomFace(face)?.spec ?? {})}`)
    render.nl()
  }
  render.text("  ")
  render.button("[Insert Additional Face]", { type: "new-theme", action: "insert-face" })
  render.nl()
  render.nl()
  render.text("  Theme variables:")
  render.nl()
  for (const name of state.variables) {
    render.text("  ")
    render.button(`[${unlispifyTagName(name)}]`, { type: "browse-visit", kind: "variable", name })
    render.text(`: ${JSON.stringify(getCustomVariable(name)?.value ?? null)}`)
    render.nl()
  }
  render.text("  ")
  render.button("[Insert Variable]", { type: "new-theme", action: "insert-variable" })
  render.nl()

  render.finish()
  const body = render.build()
  const buffer = editor.scratch("*Custom Theme*", body, "custom-new-theme-mode")
  buffer.readOnly = false
  buffer.dirty = false
  buffer.locals.set(CUSTOM_NEW_THEME_KEY, state)
  buffer.locals.set(CUSTOM_WIDGETS_KEY, render.widgets)
  buffer.locals.set(CUSTOM_FIELDS_KEY, render.fields)
  buffer.locals.set(CUSTOM_SPANS_KEY, render.spans)
  buffer.locals.delete(CUSTOM_SPEC_KEY)
  buffer.locals.delete(CUSTOMIZE_THEME_KEY)
  buffer.locals.delete(CUSTOM_BROWSE_KEY)
  buffer.locals.set(CUSTOMIZE_VARIABLE_KEY, [...state.variables])
  buffer.locals.set(CUSTOMIZE_FACE_KEY, [...state.faces])
  buffer.locals.set(REVERT_BUFFER_FUNCTION_KEY, "customize-refresh")
  buffer.setEditableFields(render.fields)
  buffer.point = 0
}

function captureNewThemeFields(buffer: BufferModel, state: NewThemeState): void {
  for (const field of bufferFields(buffer)) {
    if (field.ref.kind === "theme-name") state.themeName = fieldText(buffer, field).trim()
    else if (field.ref.kind === "theme-description") state.description = fieldText(buffer, field).trim()
  }
}

async function invokeNewThemeWidget(editor: Editor): Promise<void> {
  const buffer = editor.currentBuffer
  const state = newThemeState(buffer)!
  captureNewThemeFields(buffer, state)
  const widget = widgetAtPoint(buffer)
  if (!widget) return void editor.message("No widget at point")
  if (widget.action.type === "face-link") return void await editor.run("customize-face", [widget.action.face])
  if (widget.action.type === "browse-visit") return void await editor.run("customize-variable", [widget.action.name])
  if (widget.action.type !== "new-theme") return void editor.message("No widget at point")
  switch (widget.action.action) {
    case "save":
      await editor.run("custom-theme-write")
      return
    case "insert-face":
      await editor.run("custom-theme-add-face")
      return
    case "insert-variable":
      await editor.run("custom-theme-add-variable")
      return
    case "remove-saved":
      state.removeSaved = !state.removeSaved
      showNewThemeBuffer(editor, state)
      return
    case "visit":
    case "merge": {
      const name = await editor.completingRead(
        widget.action.action === "visit" ? "Find custom theme: " : "Merge custom theme: ",
        { collection: listBuiltinThemeNames(), history: "custom-theme" },
      )
      if (!name) return
      if (widget.action.action === "visit") {
        showNewThemeBuffer(editor, newThemeStateFor(name))
      } else {
        // Merge keeps the current settings and adds the theme's own.
        const merged = newThemeStateFor(name)
        state.faces = [...new Set([...state.faces, ...merged.faces])]
        state.variables = [...new Set([...state.variables, ...merged.variables])]
        showNewThemeBuffer(editor, state)
      }
      return
    }
    case "revert":
      showNewThemeBuffer(editor, newThemeStateFor(state.themeName || "user"))
      return
  }
}

// ---------------------------------------------------------------------------
// Value formatting
// ---------------------------------------------------------------------------




/** cus-edit.el `custom-unlispify-tag-name`: `tab-width` → `Tab Width`. */
export function unlispifyTagName(symbol: string): string {
  if (!(getCustom<boolean>("custom-unlispify-tag-names") ?? true)) return symbol
  return symbol
    .split(/[-:/]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}

function lispifyTagName(tag: string): string {
  const trimmed = tag.trim()
  if (getCustomGroup(trimmed) || getCustomVariable(trimmed)) return trimmed
  const lisp = trimmed.toLowerCase().replace(/\s+/g, "-")
  return lisp
}

function showCurrentBufferInOtherWindow(editor: Editor): void {
  editor.displayBufferInOtherWindow(editor.currentBuffer.id)
}

function showWidgetBrowser(editor: Editor, widget = "widget"): void {
  const variable = widget ? getCustomVariable(widget) : null
  const theme = widget ? getBuiltinTheme(widget) : null
  const lines = [
    "Widget Browser",
    "",
    `Widget: ${widget}`,
    variable ? `Type: ${customTypeLabel(variable.type)}`
      : theme ? `Type: custom-theme (${themeSource(widget)})`
        : "Type: unknown",
  ]
  editor.scratch("*Widget Browser*", lines.join("\n"), "help")
}
