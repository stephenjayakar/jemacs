import { registerCatalogEntry } from "./definitions"
import type { SourceLocation } from "./source"
import { captureCallerSource } from "./source"

/** Emacs `defcustom :type` widgets that hold a single value. Spelled with the
 *  Emacs widget name, so `:type 'integer` is `"integer"` here. */
export type CustomScalarType =
  | "boolean"
  | "integer"
  | "natnum"
  | "number"
  | "string"
  | "regexp"
  | "file"
  | "directory"
  | "symbol"
  | "function"
  | "face"
  | "color"
  | "sexp"

/** One arm of a `choice`/`set` widget: `(const :tag "Tag" VALUE)` or a type. */
export type CustomChoice =
  | { const: unknown; tag?: string }
  | { type: CustomType; tag?: string }

/** Emacs composite `defcustom :type` widgets. */
export type CustomCompositeType =
  | { kind: "choice"; options: CustomChoice[]; tag?: string }
  | { kind: "repeat"; item: CustomType; tag?: string }
  | { kind: "alist"; key: CustomType; value: CustomType }
  | { kind: "set"; options: CustomChoice[] }
  | { kind: "hook" }
  /** `(list T1 T2 ...)`: a fixed-arity group, each child on its own line. */
  | { kind: "list"; items: CustomType[]; tag?: string }
  /** `plist`: a repeat of `Key:`/`Value:` pairs. */
  | { kind: "plist" }
  /** A keyed group. Not a `defcustom :type`: it addresses the attribute rows
   *  of a face, which are keyed by name rather than by position. */
  | { kind: "record"; members: Record<string, CustomType> }

export type CustomType = CustomScalarType | CustomCompositeType

export function isCompositeType(type: CustomType): type is CustomCompositeType {
  return typeof type === "object"
}

/** cus-edit.el widget `:tag`: the label printed before the value. */
export function customTypeLabel(type: CustomType): string {
  if (typeof type === "string") {
    switch (type) {
      case "boolean": return "Boolean"
      case "integer": return "Integer"
      case "natnum": return "Integer (positive or zero)"
      case "number": return "Number"
      case "string": return "String"
      case "regexp": return "Regexp"
      case "file": return "File"
      case "directory": return "Directory"
      case "symbol": return "Symbol"
      case "function": return "Function"
      case "face": return "Face"
      case "color": return "Color"
      case "sexp": return "Lisp expression"
    }
  }
  switch (type.kind) {
    case "choice": return type.tag ?? "Choice"
    case "repeat": return type.tag ?? "Repeat"
    case "alist": return "Alist"
    case "set": return "Set"
    case "hook": return "Hook"
    case "list": return type.tag ?? "List"
    case "plist": return "Plist"
    case "record": return "Record"
  }
}

export type CustomVariable<T = unknown> = {
  name: string
  type: CustomType
  value: T
  doc?: string
  group?: string
  source?: SourceLocation
  baselineValue?: unknown
  savedValue?: unknown
  patched?: boolean
  customized?: boolean
  /** Emacs `variable-comment`, and its `saved-variable-comment` counterpart. */
  comment?: string
  savedComment?: string
}

/** A `:link` on a group or option, rendered by `custom-add-see-also`. */
export type CustomLink = { tag: string; manual?: string; url?: string }

/** `defgroup`: a customization group, i.e. a node of the Custom tree. */
export type CustomGroup = {
  name: string
  doc?: string
  parent?: string
  /** `custom-tag`: display name, when it is not the unlispified symbol
   *  (Emacs names the group `comm` but tags it "Communication"). */
  tag?: string
  /** `:link` entries, printed as `See also [Tag].` */
  links?: CustomLink[]
  /** Child groups in *declaration* order, as `(get SYMBOL 'custom-group)` is. */
  children: string[]
  /** Auto-created by a `:group` reference rather than a real `defgroup`; its
   *  slot in the parent's child list is provisional until `defgroup` runs. */
  implicit?: boolean
  source?: SourceLocation
}

export type DefgroupOptions = {
  parent?: string
  tag?: string
  links?: CustomLink[]
}

/** Emacs' top-level customization group. Every group whose parent is unknown
 *  hangs off it, so `M-x customize` always has a root, as in Emacs. */
export const TOP_CUSTOM_GROUP = "emacs"

const variables = new Map<string, CustomVariable>()
const groups = new Map<string, CustomGroup>()
/** `custom-set-variables` seen before the `defcustom` that defines the option:
 *  the saved value waits here and is installed when the option shows up. */
const pendingSavedValues = new Map<string, unknown>()

defgroup(TOP_CUSTOM_GROUP, "Customization of the One True Editor.",
  { links: [{ tag: "Manual", manual: "(emacs)Top" }] })

/** `custom-add-to-group`: append CHILD to PARENT's ordered member list. */
function addToGroup(parent: string, child: string): void {
  const group = groups.get(parent)
  if (!group || group.children.includes(child)) return
  group.children.push(child)
}

export function defgroup(name: string, doc?: string, options: string | DefgroupOptions = {}): CustomGroup {
  const source = captureCallerSource(3)
  // A bare string keeps the two-positional-argument form working.
  const opts: DefgroupOptions = typeof options === "string" ? { parent: options } : options
  const existing = groups.get(name)
  if (existing) {
    if (doc) existing.doc = doc
    if (opts.tag) existing.tag = opts.tag
    if (opts.links) existing.links = opts.links
    const parent = opts.parent ?? existing.parent
    // A group that only existed because some `:group` mentioned it has no real
    // place in its parent's list yet, so `defgroup` (re)appends it here. That
    // makes the child order match declaration order, which is what the root
    // group displays.
    if (parent !== existing.parent || existing.implicit) {
      const old = existing.parent && groups.get(existing.parent)
      if (old) old.children = old.children.filter(child => child !== name)
      existing.parent = parent
      if (parent) {
        ensureCustomGroup(parent)
        addToGroup(parent, name)
      }
    }
    existing.implicit = false
    if (source) existing.source = source
    registerCatalogEntry({ kind: "variable", name: `group:${name}`, source: existing.source, doc: existing.doc })
    return existing
  }
  const parent = opts.parent ?? (name === TOP_CUSTOM_GROUP ? undefined : TOP_CUSTOM_GROUP)
  const group: CustomGroup = { name, doc, parent, tag: opts.tag, links: opts.links, children: [], source }
  groups.set(name, group)
  if (parent) {
    ensureCustomGroup(parent)
    addToGroup(parent, name)
  }
  registerCatalogEntry({ kind: "variable", name: `group:${name}`, source, doc })
  return group
}

/** Auto-create the group a `defcustom`/`defface` names, as Emacs does when a
 *  `:group` is declared before its `defgroup` is loaded. */
export function ensureCustomGroup(name: string | undefined): void {
  if (!name || groups.has(name)) return
  const parent = name === TOP_CUSTOM_GROUP ? undefined : TOP_CUSTOM_GROUP
  groups.set(name, { name, parent, children: [], implicit: true })
  if (parent) addToGroup(parent, name)
}

/** Child groups of NAME in declaration order, as `(get NAME 'custom-group)`. */
export function customGroupChildren(name: string): string[] {
  return [...(groups.get(name)?.children ?? [])]
}

export function getCustomGroup(name: string): CustomGroup | undefined {
  return groups.get(name)
}

export function listCustomGroups(): CustomGroup[] {
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function defcustom<T>(name: string, type: CustomType, value: T, doc?: string, group?: string): CustomVariable<T> {
  const source = captureCallerSource(3)
  ensureCustomGroup(group)
  const existing = variables.get(name)
  if (existing) {
    // Set-if-unbound for the value, but refresh metadata so describe-variable
    // and the customize catalog track the re-evaluated definition.
    existing.type = type
    existing.doc = doc
    existing.group = group
    existing.source = source
    existing.baselineValue = value
    registerCatalogEntry({ kind: "variable", name, source, doc, patched: existing.patched })
    return existing as CustomVariable<T>
  }
  const variable: CustomVariable<T> = { name, type, value, doc, group, source, baselineValue: value, patched: false }
  variables.set(name, variable as CustomVariable)
  if (pendingSavedValues.has(name)) {
    variable.value = pendingSavedValues.get(name) as T
    variable.savedValue = variable.value
    variable.customized = true
    pendingSavedValues.delete(name)
  }
  registerCatalogEntry({ kind: "variable", name, source, doc, patched: false })
  return variable
}

/** `custom-set-variables`: install saved values read back from the custom file.
 *  Options that are not defined yet keep their value pending until `defcustom`. */
export function customSetVariables(...specs: Array<[string, unknown, string?]>): void {
  for (const [name, value, comment] of specs) {
    const variable = variables.get(name)
    if (!variable) {
      pendingSavedValues.set(name, value)
      continue
    }
    variable.value = value
    variable.savedValue = value
    variable.customized = true
    if (comment !== undefined) {
      variable.comment = comment
      variable.savedComment = comment
    }
    registerCatalogEntry({ kind: "variable", name, source: variable.source, patched: variable.patched, doc: variable.doc })
  }
}

export function defvar<T>(name: string, value: T, doc?: string, group?: string): CustomVariable<T> {
  const type: CustomType = typeof value === "boolean"
    ? "boolean"
    : typeof value === "number"
      ? (Number.isInteger(value) ? "integer" : "number")
      : typeof value === "object"
        ? "sexp"
        : "string"
  return defcustom(name, type, value, doc, group)
}

export function getCustom<T>(name: string): T | undefined {
  return variables.get(name)?.value as T | undefined
}

/** `customize-set-value`: plain `set`, *not* a Customize customization. Emacs
 *  records no `customized-value`, so `custom-variable-state` reports the option
 *  as CHANGED outside Customize rather than SET for this session. */
export function setCustomValue<T>(name: string, value: T): void {
  const variable = variables.get(name)
  if (!variable) throw new Error(`Unknown custom variable: ${name}`)
  if (variable.baselineValue === undefined) variable.baselineValue = variable.value
  variable.value = value as unknown
  variable.patched = true
  registerCatalogEntry({ kind: "variable", name, source: variable.source, patched: true, doc: variable.doc })
}

export function setCustom<T>(name: string, value: T): void {
  const variable = variables.get(name)
  if (!variable) throw new Error(`Unknown custom variable: ${name}`)
  variable.value = value as unknown
  variable.customized = true
  registerCatalogEntry({ kind: "variable", name, source: variable.source, patched: variable.patched, doc: variable.doc })
}

export function saveCustom<T>(name: string, value?: T): void {
  const variable = variables.get(name)
  if (!variable) throw new Error(`Unknown custom variable: ${name}`)
  if (arguments.length >= 2) variable.value = value as unknown
  variable.savedValue = variable.value
  variable.savedComment = variable.comment
  variable.customized = true
  registerCatalogEntry({ kind: "variable", name, source: variable.source, patched: variable.patched, doc: variable.doc })
}

/** Emacs `variable-comment`: a free-text note attached to an option. CUSTOMIZE
 *  says whether this also counts as a Customize customization, which is true
 *  for the Customize setters and false for plain `customize-set-value`. */
export function setCustomComment(name: string, comment: string | undefined, customize = true): boolean {
  const variable = variables.get(name)
  if (!variable) return false
  variable.comment = comment || undefined
  if (customize) variable.customized = true
  return true
}

export function resetCustom(name: string): boolean {
  const variable = variables.get(name)
  if (!variable) return false
  const baseline = variable.baselineValue
  if (baseline === undefined) return false
  variable.value = baseline
  variable.customized = false
  variable.savedValue = undefined
  variable.comment = undefined
  variable.savedComment = undefined
  registerCatalogEntry({ kind: "variable", name, source: variable.source, patched: variable.patched, doc: variable.doc })
  return true
}

export function resetCustomToSaved(name: string): boolean {
  const variable = variables.get(name)
  if (!variable || variable.savedValue === undefined) return false
  variable.value = variable.savedValue
  variable.comment = variable.savedComment
  variable.customized = true
  registerCatalogEntry({ kind: "variable", name, source: variable.source, patched: variable.patched, doc: variable.doc })
  return true
}

export function patchCustom<T>(name: string, value: T): void {
  const variable = variables.get(name)
  if (!variable) throw new Error(`Unknown custom variable: ${name}`)
  if (variable.baselineValue === undefined) variable.baselineValue = variable.value
  variable.value = value as unknown
  variable.patched = true
  registerCatalogEntry({ kind: "variable", name, source: variable.source, patched: true, doc: variable.doc })
}

export function restoreCustom(name: string): boolean {
  const variable = variables.get(name)
  if (!variable?.patched || variable.baselineValue === undefined) return false
  variable.value = variable.baselineValue
  variable.patched = false
  registerCatalogEntry({ kind: "variable", name, source: variable.source, patched: false, doc: variable.doc })
  return true
}

export function getCustomVariable(name: string): CustomVariable | undefined {
  return variables.get(name)
}

export function listCustomVariables(): CustomVariable[] {
  return [...variables.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------------------
// Icons (`define-icon` / `customize-icon`)
// ---------------------------------------------------------------------------

/** One `define-icon` entry: a display kind, its values, and its keyword plist.
 *  Emacs writes `(text "button" :face icon-button)`; `values` is everything
 *  before the first keyword and `keywords` is the plist after it. */
export type CustomIconSpec = {
  kind: "image" | "emoji" | "symbol" | "text"
  values: string[]
  keywords?: Array<[string, string]>
}

export type CustomIcon = {
  name: string
  spec: CustomIconSpec[]
  doc?: string
  group?: string
  savedSpec?: CustomIconSpec[]
  customized?: boolean
  baselineSpec: CustomIconSpec[]
}

const icons = new Map<string, CustomIcon>()

/** Emacs `define-icon`. */
export function defineIcon(name: string, spec: CustomIconSpec[], doc?: string, group?: string): CustomIcon {
  ensureCustomGroup(group)
  const existing = icons.get(name)
  if (existing) {
    existing.doc = doc
    existing.group = group
    existing.baselineSpec = spec.map(entry => ({ ...entry }))
    return existing
  }
  const icon: CustomIcon = {
    name,
    spec: spec.map(entry => ({ ...entry })),
    doc,
    group,
    baselineSpec: spec.map(entry => ({ ...entry })),
  }
  icons.set(name, icon)
  return icon
}

export function getCustomIcon(name: string): CustomIcon | undefined {
  return icons.get(name)
}

export function listCustomIcons(): CustomIcon[] {
  return [...icons.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** `custom-icon-set`: install a session value for the icon. */
export function setCustomIcon(name: string, spec: CustomIconSpec[]): boolean {
  const icon = icons.get(name)
  if (!icon) return false
  icon.spec = spec.map(entry => ({ ...entry }))
  icon.customized = true
  return true
}

/** `custom-icon-save`. */
export function saveCustomIcon(name: string): boolean {
  const icon = icons.get(name)
  if (!icon) return false
  icon.savedSpec = icon.spec.map(entry => ({ ...entry }))
  icon.customized = true
  return true
}

/** `custom-icon-reset-standard`. */
export function resetCustomIcon(name: string): boolean {
  const icon = icons.get(name)
  if (!icon) return false
  icon.spec = icon.baselineSpec.map(entry => ({ ...entry }))
  icon.savedSpec = undefined
  icon.customized = false
  return true
}

/** `custom-icon-reset-saved`. */
export function resetCustomIconToSaved(name: string): boolean {
  const icon = icons.get(name)
  if (!icon?.savedSpec) return false
  icon.spec = icon.savedSpec.map(entry => ({ ...entry }))
  icon.customized = true
  return true
}

/** `custom-set-icons`: restore saved icon specs from the custom file. */
export function customSetIcons(...specs: Array<[string, CustomIconSpec[]]>): void {
  for (const [name, spec] of specs) {
    if (!icons.has(name)) defineIcon(name, [])
    const icon = icons.get(name)!
    icon.spec = spec.map(entry => ({ ...entry }))
    icon.savedSpec = spec.map(entry => ({ ...entry }))
    icon.customized = true
  }
}
