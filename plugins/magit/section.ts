import type { BufferModel } from "../../src/kernel/buffer"
import type { Editor } from "../../src/kernel/editor"
import { addHook, getHooks, runHooks } from "../../src/kernel/hooks"
import { Keymap } from "../../src/kernel/keymap"
import { addPointKeymapSource } from "../../src/kernel/extension-points"
import { defineMode, modeLineage, type FaceName, type TextSpan } from "../../src/modes/mode"
import { defcustom, getCustom } from "../../src/runtime/custom"
import { defface } from "../../src/runtime/faces"

export const MAGIT_ROOT_SECTION_LOCAL = "magit-root-section"
export const MAGIT_SECTION_VISIBILITY_CACHE_LOCAL = "magit-section-visibility-cache"
const MAGIT_SECTION_FILTER_CACHE_LOCAL = "magit-section-display-filter-cache"
const MAGIT_SECTION_GLOBAL_CYCLE_LOCAL = "magit-section-global-cycle"
const MAGIT_SECTION_PRE_COMMAND_IDENT_LOCAL = "magit-section-pre-command-ident"

export type MagitSectionVisibility = "show" | "hide"
export type MagitSectionIdent = Array<[string, unknown]>
export type MagitSectionMatch = string | readonly string[] | ((section: MagitSection) => boolean)
export type MagitSectionInitialVisibilityEntry = readonly [
  MagitSectionMatch,
  MagitSectionVisibility | ((section: MagitSection) => MagitSectionVisibility | null | undefined),
]
export type MagitSectionWasher = (builder: MagitSectionBuilder, section: MagitSection) => void

export type MagitSectionOptions = {
  type: string
  value?: unknown
  hidden?: boolean
  washer?: MagitSectionWasher | null
  keymap?: Keymap | null
  headingHighlightFace?: FaceName | null
  headingSelectionFace?: FaceName | null
  selectiveHighlight?: boolean
}

export class MagitSection {
  type: string
  value: unknown
  start: number
  content: number
  end: number
  hidden: boolean
  painted = false
  washer: MagitSectionWasher | null
  parent: MagitSection | null = null
  children: MagitSection[] = []
  keymap: Keymap | null
  headingHighlightFace: FaceName | null
  headingSelectionFace: FaceName | null
  selectiveHighlight: boolean

  constructor(options: MagitSectionOptions & { start?: number; content?: number; end?: number } = { type: "root" }) {
    this.type = options.type
    this.value = options.value
    this.start = options.start ?? 0
    this.content = options.content ?? this.start
    this.end = options.end ?? this.content
    this.hidden = options.hidden ?? false
    this.washer = options.washer ?? null
    this.keymap = options.keymap ?? null
    this.headingHighlightFace = options.headingHighlightFace ?? null
    this.headingSelectionFace = options.headingSelectionFace ?? null
    this.selectiveHighlight = options.selectiveHighlight ?? false
  }
}

export type MagitSectionBuilderOptions = {
  root?: MagitSection
  initialOffset?: number
  visibilityCache?: Map<string, MagitSectionVisibility>
}

export class MagitSectionBuilder {
  readonly root: MagitSection
  private readonly stack: MagitSection[]
  private readonly visibilityCache?: Map<string, MagitSectionVisibility>
  private parts: string[] = []
  private lengthValue: number

  constructor(options: MagitSectionBuilderOptions = {}) {
    this.root = options.root ?? new MagitSection({ type: "root", start: options.initialOffset ?? 0 })
    this.lengthValue = options.initialOffset ?? this.root.start
    this.root.content = this.root.start
    this.root.end = this.lengthValue
    this.stack = [this.root]
    this.visibilityCache = options.visibilityCache
  }

  get length(): number {
    return this.lengthValue
  }

  get current(): MagitSection {
    return this.stack[this.stack.length - 1]!
  }

  toString(): string {
    return this.parts.join("")
  }

  insert(text: string): void {
    if (!text) return
    this.parts.push(text)
    this.lengthValue += text.length
    this.root.end = Math.max(this.root.end, this.lengthValue)
  }

  insertHeading(...parts: unknown[]): void {
    const section = this.current
    let text = parts.map(part => String(part)).join("")
    if (!text.endsWith("\n")) text += "\n"
    this.insert(text)
    section.content = this.length
  }

  insertSection(options: MagitSectionOptions, body: (section: MagitSection) => void): MagitSection {
    const parent = this.current
    const section = new MagitSection({
      ...options,
      start: this.length,
      content: this.length,
      end: this.length,
      hidden: options.hidden ?? false,
    })
    section.parent = parent
    section.hidden = this.initialHidden(section, options.hidden ?? false)
    parent.children.push(section)
    this.stack.push(section)
    try {
      body(section)
    } catch (error) {
      this.stack.pop()
      this.cancelSection(section)
      throw error
    }
    if (section.content < section.start) section.content = section.start
    section.end = this.length
    this.stack.pop()
    return section
  }

  cancelSection(section: MagitSection = this.current): void {
    if (!section.parent) return
    this.truncate(section.start)
    const siblings = section.parent.children
    const index = siblings.indexOf(section)
    if (index >= 0) siblings.splice(index, 1)
    const stackIndex = this.stack.indexOf(section)
    if (stackIndex >= 0) this.stack.splice(stackIndex, this.stack.length - stackIndex)
    section.content = section.start
    section.end = section.start
  }

  private truncate(length: number): void {
    const target = Math.max(0, Math.min(length, this.lengthValue))
    let remove = this.lengthValue - target
    while (remove > 0 && this.parts.length) {
      const last = this.parts[this.parts.length - 1]!
      if (last.length <= remove) {
        this.parts.pop()
        remove -= last.length
      } else {
        this.parts[this.parts.length - 1] = last.slice(0, last.length - remove)
        remove = 0
      }
    }
    this.lengthValue = target
    this.root.end = Math.min(this.root.end, this.lengthValue)
  }

  private initialHidden(section: MagitSection, fallback: boolean): boolean {
    const cached = this.visibilityCache?.get(sectionIdentKey(sectionIdent(section)))
    if (cached) return cached === "hide"
    const initial = initialVisibility(section)
    if (initial) return initial === "hide"
    return fallback
  }
}

export function insertSection(builder: MagitSectionBuilder, options: MagitSectionOptions, body: (section: MagitSection) => void): MagitSection {
  return builder.insertSection(options, body)
}

export function insertHeading(builder: MagitSectionBuilder, ...parts: unknown[]): void {
  builder.insertHeading(...parts)
}

export function cancelSection(builder: MagitSectionBuilder, section?: MagitSection): void {
  builder.cancelSection(section)
}

export function washSequence<T>(
  builder: MagitSectionBuilder,
  items: Iterable<T>,
  washer: (builder: MagitSectionBuilder, item: T) => void,
): void {
  for (const item of items) washer(builder, item)
}

export function rootSection(buffer: BufferModel): MagitSection | null {
  return (buffer.locals.get(MAGIT_ROOT_SECTION_LOCAL) as MagitSection | undefined) ?? null
}

export function setRootSection(buffer: BufferModel, root: MagitSection): void {
  root.end = Math.max(root.end, buffer.text.length)
  buffer.locals.set(MAGIT_ROOT_SECTION_LOCAL, root)
  if (!buffer.locals.get(MAGIT_SECTION_VISIBILITY_CACHE_LOCAL)) {
    buffer.locals.set(MAGIT_SECTION_VISIBILITY_CACHE_LOCAL, new Map<string, MagitSectionVisibility>())
  }
  buffer.locals.delete(MAGIT_SECTION_FILTER_CACHE_LOCAL)
}

export function visibilityCache(buffer: BufferModel): Map<string, MagitSectionVisibility> {
  const existing = buffer.locals.get(MAGIT_SECTION_VISIBILITY_CACHE_LOCAL) as Map<string, MagitSectionVisibility> | undefined
  if (existing) return existing
  const cache = new Map<string, MagitSectionVisibility>()
  buffer.locals.set(MAGIT_SECTION_VISIBILITY_CACHE_LOCAL, cache)
  return cache
}

export function currentSection(buffer: BufferModel): MagitSection | null {
  return sectionAt(buffer, buffer.point)
}

export function sectionAt(buffer: BufferModel, point: number): MagitSection | null {
  const root = rootSection(buffer)
  if (!root) return null
  const clamped = Math.max(0, Math.min(point, Math.max(root.end, buffer.text.length)))
  return deepestSectionAt(root, clamped) ?? root
}

function deepestSectionAt(section: MagitSection, point: number): MagitSection | null {
  if (point < section.start || (section.parent ? point >= section.end : point > section.end)) return null
  for (const child of section.children) {
    const found = deepestSectionAt(child, point)
    if (found) return found
  }
  return section
}

export function sectionIdent(section: MagitSection): MagitSectionIdent {
  const lineage = sectionLineage(section).filter(entry => entry.parent)
  return lineage.map(entry => [entry.type, sectionIdentValue(entry.value)])
}

export function sectionIdentValue(value: unknown): unknown {
  return stableIdentValue(value)
}

export function sectionIdentKey(ident: MagitSectionIdent): string {
  return JSON.stringify(ident)
}

export function sectionLineage(section: MagitSection): MagitSection[] {
  const out: MagitSection[] = []
  for (let cur: MagitSection | null = section; cur; cur = cur.parent) out.push(cur)
  return out.reverse()
}

export function sectionParentValue(section: MagitSection): unknown {
  return section.parent?.value
}

export function getSection(buffer: BufferModel, ident: MagitSectionIdent): MagitSection | null {
  const wanted = sectionIdentKey(ident)
  let found: MagitSection | null = null
  mapSections(buffer, section => {
    if (!found && sectionIdentKey(sectionIdent(section)) === wanted) found = section
  })
  return found
}

export function sectionSiblings(section: MagitSection): MagitSection[] {
  return section.parent?.children ?? []
}

export function sectionEqual(a: MagitSection | null | undefined, b: MagitSection | null | undefined): boolean {
  if (!a || !b) return false
  return sectionIdentKey(sectionIdent(a)) === sectionIdentKey(sectionIdent(b))
}

export function mapSections(bufferOrSection: BufferModel | MagitSection, fn: (section: MagitSection, depth: number) => void): void {
  const root = bufferOrSection instanceof MagitSection ? bufferOrSection : rootSection(bufferOrSection)
  if (!root) return
  const visit = (section: MagitSection, depth: number) => {
    fn(section, depth)
    for (const child of section.children) visit(child, depth + 1)
  }
  visit(root, 0)
}

export function sectionMatch(section: MagitSection, match: MagitSectionMatch): boolean {
  if (typeof match === "function") return match(section)
  if (typeof match === "string") return section.type === match
  const types = sectionLineage(section).filter(entry => entry.parent).map(entry => entry.type)
  if (match.length > types.length) return false
  const offset = types.length - match.length
  return match.every((entry, index) => entry === "*" || entry === types[offset + index])
}

export function sectionValueIf<T = unknown>(section: MagitSection | null, match: MagitSectionMatch): T | null {
  return section && sectionMatch(section, match) ? section.value as T : null
}

export function sectionMatchAssoc<T>(section: MagitSection, entries: Array<readonly [MagitSectionMatch, T]>): T | null {
  for (const [match, value] of entries) if (sectionMatch(section, match)) return value
  return null
}

export function sectionPositionInHeading(section: MagitSection, point: number): boolean {
  return section.content > section.start && point >= section.start && point < section.content
}

export function sectionContentP(section: MagitSection, point: number): boolean {
  return point >= section.content && point < section.end
}

export function sectionHidden(section: MagitSection): boolean {
  return section.hidden
}

export const sectionInvisibleP = sectionHidden

export function showSection(buffer: BufferModel, section: MagitSection): void {
  if (section.washer) runSectionWasher(buffer, section)
  setSectionHidden(buffer, section, false)
}

export function hideSection(buffer: BufferModel, section: MagitSection): void {
  if (!section.parent) return
  setSectionHidden(buffer, section, true)
}

export function toggleSection(buffer: BufferModel, section: MagitSection): void {
  if (section.hidden) showSection(buffer, section)
  else hideSection(buffer, section)
}

export function showChildren(buffer: BufferModel, section: MagitSection): void {
  for (const child of section.children) showSection(buffer, child)
}

export function hideChildren(buffer: BufferModel, section: MagitSection): void {
  for (const child of section.children) hideSection(buffer, child)
}

export function showHeadings(buffer: BufferModel, section: MagitSection): void {
  for (const child of section.children) {
    showSection(buffer, child)
    hideChildren(buffer, child)
  }
}

export function showLevel(buffer: BufferModel, level: number, all = false): void {
  const target = all ? rootSection(buffer) : currentSection(buffer)
  if (!target) return
  const baseDepth = sectionDepth(target)
  mapSections(target, section => {
    if (section === target) {
      showSection(buffer, section)
      return
    }
    const relativeDepth = sectionDepth(section) - baseDepth
    if (relativeDepth < level) showSection(buffer, section)
    else hideSection(buffer, section)
  })
}

export function cycleSection(buffer: BufferModel, section: MagitSection): "show" | "hide-children" | "show-children" {
  if (section.hidden) {
    showSection(buffer, section)
    return "show"
  }
  if (section.children.some(child => child.hidden)) {
    showChildren(buffer, section)
    return "show-children"
  }
  if (section.children.length) {
    hideChildren(buffer, section)
    return "hide-children"
  }
  hideSection(buffer, section)
  return "hide-children"
}

export function cycleGlobal(buffer: BufferModel): number {
  const current = (buffer.locals.get(MAGIT_SECTION_GLOBAL_CYCLE_LOCAL) as number | undefined) ?? 0
  const next = (current + 1) % 3
  buffer.locals.set(MAGIT_SECTION_GLOBAL_CYCLE_LOCAL, next)
  if (next === 0) showLevel(buffer, 1, true)
  else if (next === 1) showLevel(buffer, 2, true)
  else showLevel(buffer, Number.MAX_SAFE_INTEGER, true)
  return next
}

export function visibleSections(buffer: BufferModel): MagitSection[] {
  const root = rootSection(buffer)
  if (!root) return []
  const out: MagitSection[] = []
  const visit = (section: MagitSection, hiddenAncestor: boolean) => {
    const hidden = hiddenAncestor || section.hidden
    if (section.parent && !hiddenAncestor) out.push(section)
    if (hidden) return
    for (const child of section.children) visit(child, hidden)
  }
  for (const child of root.children) visit(child, false)
  return out.sort((a, b) => a.start - b.start)
}

export function magitRegionSections(buffer: BufferModel): MagitSection[] {
  if (buffer.mark == null || !buffer.markActive || buffer.mark === buffer.point) {
    const section = currentSection(buffer)
    return section?.parent ? [section] : []
  }
  const start = Math.min(buffer.mark, buffer.point)
  const end = Math.max(buffer.mark, buffer.point)
  const sections: MagitSection[] = []
  mapSections(buffer, section => {
    if (!section.parent) return
    if (section.end > start && section.start < end) sections.push(section)
  })
  return sections
}

export function magitRegionValues<T = unknown>(buffer: BufferModel): T[] {
  return magitRegionSections(buffer).map(section => section.value as T)
}

export function magitFocusedSections(buffer: BufferModel): MagitSection[] {
  return magitRegionSections(buffer)
}

export function magitSectionSelectedP(buffer: BufferModel, section: MagitSection): boolean {
  return magitRegionSections(buffer).includes(section)
}

export function magitSectionInternalRegionP(buffer: BufferModel): boolean {
  return !!rootSection(buffer) && buffer.markActive && buffer.mark != null
}

type HiddenRange = { from: number; to: number; replacement: string }
type DisplayPiece =
  | { kind: "visible"; from: number; to: number; displayStart: number }
  | { kind: "hidden"; from: number; to: number; displayStart: number; replacementLength: number }

export function magitSectionDisplayFilter(buffer: BufferModel): { text: string; map: (n: number) => number; unmap: (n: number) => number } | null {
  const root = rootSection(buffer)
  if (!root) return null
  const ranges = hiddenRanges(root, buffer.text)
  if (!ranges.length) return null
  const cache = buffer.locals.get(MAGIT_SECTION_FILTER_CACHE_LOCAL) as
    | { text: string; state: string; result: { text: string; map: (n: number) => number; unmap: (n: number) => number } }
    | undefined
  const state = ranges.map(range => `${range.from}:${range.to}:${range.replacement}`).join("|")
  if (cache?.text === buffer.text && cache.state === state) return cache.result

  const pieces: DisplayPiece[] = []
  const parts: string[] = []
  let source = 0
  let display = 0
  for (const range of ranges) {
    if (range.from > source) {
      pieces.push({ kind: "visible", from: source, to: range.from, displayStart: display })
      parts.push(buffer.text.slice(source, range.from))
      display += range.from - source
    }
    pieces.push({ kind: "hidden", from: range.from, to: range.to, displayStart: display, replacementLength: range.replacement.length })
    parts.push(range.replacement)
    display += range.replacement.length
    source = range.to
  }
  if (source < buffer.text.length) {
    pieces.push({ kind: "visible", from: source, to: buffer.text.length, displayStart: display })
    parts.push(buffer.text.slice(source))
  }
  const text = parts.join("")
  const map = (n: number): number => mapOffset(pieces, Math.max(0, Math.min(n, buffer.text.length)), text.length)
  const unmap = (n: number): number => unmapOffset(pieces, Math.max(0, Math.min(n, text.length)), buffer.text.length)
  const result = { text, map, unmap }
  buffer.locals.set(MAGIT_SECTION_FILTER_CACHE_LOCAL, { text: buffer.text, state, result })
  return result
}

export function magitSectionOverlaySpans(buffer: BufferModel): TextSpan[] {
  const root = rootSection(buffer)
  if (!root) return []
  const spans: TextSpan[] = []
  mapSections(root, section => {
    if (!section.parent || section.content <= section.start) return
    spans.push({ start: section.start, end: Math.min(section.content, section.end), face: "magit-section-heading" })
  })

  const current = currentSection(buffer)
  if (current?.parent && getCustom<boolean>("magit-section-highlight-current") !== false) {
    const face = current.headingHighlightFace ?? "magit-section-highlight"
    spans.push({ start: current.start, end: Math.min(current.content || current.end, current.end), face })
  }

  if (getCustom<boolean>("magit-section-highlight-selection") !== false && magitSectionInternalRegionP(buffer)) {
    for (const section of magitRegionSections(buffer)) {
      const face = section.headingSelectionFace ?? "magit-section-heading-selection"
      spans.push({ start: section.start, end: Math.min(section.content || section.end, section.end), face })
    }
  }
  return spans
}

export function defineSectionTypeKeymap(type: string, keymap: Keymap | null): void {
  if (keymap) sectionTypeKeymaps.set(type, keymap)
  else sectionTypeKeymaps.delete(type)
}

export function installMagitSection(editor: Editor): void {
  ensureFacesAndCustoms()
  ensurePointKeymapSources()
  ensureHooks()
  defineMode({
    name: "magit-section-mode",
    keymap: magitSectionModeMap,
    displayFilter: magitSectionDisplayFilter,
    onEnter(buffer) {
      buffer.readOnly = true
      buffer.locals.set("truncate-lines", true)
      buffer.locals.set("line-move-visual", true)
      buffer.locals.set("undo-disabled", true)
    },
  })
  if (!overlayEditors.has(editor)) {
    editor.addOverlaySource(magitSectionOverlaySpans)
    overlayEditors.add(editor)
  }
  installSectionCommands(editor)
}

function installSectionCommands(editor: Editor): void {
  editor.command("magit-undefined", ({ editor }) => {
    editor.message("Buffer is read-only")
  }, "No-op for unbound printable keys in read-only Magit section buffers.")
  editor.command("magit-section-forward", async ({ editor, buffer, prefixArgument }) => {
    if (!moveByVisibleSection(editor, buffer, prefixCount(prefixArgument))) editor.message("No next section")
  }, "Move to the next Magit section.")
  editor.command("magit-section-backward", async ({ editor, buffer, prefixArgument }) => {
    if (!moveByVisibleSection(editor, buffer, -prefixCount(prefixArgument))) editor.message("No previous section")
  }, "Move to the previous Magit section.")
  editor.command("magit-section-forward-sibling", async ({ editor, buffer, prefixArgument }) => {
    if (!moveBySibling(editor, buffer, prefixCount(prefixArgument))) editor.message("No next sibling")
  }, "Move to the next sibling Magit section.")
  editor.command("magit-section-backward-sibling", async ({ editor, buffer, prefixArgument }) => {
    if (!moveBySibling(editor, buffer, -prefixCount(prefixArgument))) editor.message("No previous sibling")
  }, "Move to the previous sibling Magit section.")
  editor.command("magit-section-up", async ({ editor, buffer, prefixArgument }) => {
    const section = currentSection(buffer)
    let target = section?.parent
    for (let i = 1; i < prefixCount(prefixArgument) && target?.parent; i++) target = target.parent
    if (!target?.parent) return editor.message("No parent section")
    await gotoSection(editor, buffer, target)
  }, "Move to the parent Magit section.")
  editor.command("magit-section-toggle", ({ editor, buffer }) => {
    const section = currentSection(buffer)
    if (!section?.parent) return editor.message("Nothing to fold at point")
    toggleSection(buffer, section)
  }, "Toggle visibility of the Magit section at point.")
  editor.command("magit-toggle-fold", async ({ editor }) => {
    await editor.run("magit-section-toggle")
  }, "Alias for magit-section-toggle.")
  editor.command("magit-section-cycle", ({ editor, buffer }) => {
    const section = currentSection(buffer)
    if (!section?.parent) return editor.message("Nothing to cycle at point")
    const action = cycleSection(buffer, section)
    editor.message(action === "show" ? "SHOW" : action === "show-children" ? "CHILDREN" : "HIDE")
  }, "Cycle visibility for the section at point.")
  editor.command("magit-section-cycle-global", ({ editor, buffer }) => {
    const state = cycleGlobal(buffer)
    editor.message(state === 0 ? "OVERVIEW" : state === 1 ? "CONTENTS" : "SHOW ALL")
  }, "Cycle global section visibility.")
  for (const level of [1, 2, 3, 4] as const) {
    editor.command(`magit-section-show-level-${level}`, ({ buffer }) => showLevel(buffer, level), `Show Magit sections down to level ${level}.`)
    editor.command(`magit-section-show-level-${level}-all`, ({ buffer }) => showLevel(buffer, level, true), `Show all Magit sections down to level ${level}.`)
  }
  editor.command("magit-section-show", ({ editor, buffer }) => {
    const section = currentSection(buffer)
    if (!section?.parent) return editor.message("No section at point")
    showSection(buffer, section)
  }, "Show the section at point.")
  editor.command("magit-section-hide", ({ editor, buffer }) => {
    const section = currentSection(buffer)
    if (!section?.parent) return editor.message("No section at point")
    hideSection(buffer, section)
  }, "Hide the section at point.")
  editor.command("magit-section-show-children", ({ editor, buffer }) => {
    const section = currentSection(buffer)
    if (!section?.parent) return editor.message("No section at point")
    showChildren(buffer, section)
  }, "Show child sections.")
  editor.command("magit-section-hide-children", ({ editor, buffer }) => {
    const section = currentSection(buffer)
    if (!section?.parent) return editor.message("No section at point")
    hideChildren(buffer, section)
  }, "Hide child sections.")
  editor.command("magit-section-show-headings", ({ editor, buffer }) => {
    const section = currentSection(buffer)
    if (!section?.parent) return editor.message("No section at point")
    showHeadings(buffer, section)
  }, "Show child headings.")
  editor.command("magit-describe-section-briefly", ({ editor, buffer }) => {
    const section = currentSection(buffer)
    editor.message(section ? `${section.type} ${JSON.stringify(sectionIdent(section))}` : "No section")
  }, "Describe the Magit section at point in the echo area.")
  editor.command("magit-describe-section", ({ editor, buffer }) => {
    const section = currentSection(buffer)
    if (!section) return editor.message("No section")
    editor.message(`${section.type} ${JSON.stringify(sectionIdent(section))} ${section.start}..${section.content}..${section.end}${section.hidden ? " hidden" : ""}`)
  }, "Describe the Magit section at point.")
}

const overlayEditors = new WeakSet<Editor>()
const sectionTypeKeymaps = new Map<string, Keymap>()
const magitSectionHeadingMap = new Keymap("magit-section-heading-map")
const magitSectionModeMap = new Keymap("magit-section-mode-map")

function ensureFacesAndCustoms(): void {
  defcustom("magit-section-cache-visibility", "sexp", true, "Whether Magit section visibility is preserved across refreshes.", "magit")
  defcustom<MagitSectionInitialVisibilityEntry[]>(
    "magit-section-initial-visibility-alist",
    "sexp",
    [["stashes", "hide"]],
    "Initial visibility for Magit sections.",
    "magit",
  )
  defcustom("magit-section-highlight-current", "boolean", true, "Highlight the current Magit section.", "magit")
  defcustom("magit-section-highlight-selection", "boolean", true, "Highlight selected Magit sections.", "magit")
  defcustom("magit-section-keep-region-overlay", "boolean", false, "Keep the ordinary region overlay while highlighting sections.", "magit")
  defcustom("magit-section-disable-line-numbers", "boolean", true, "Disable line numbers in Magit section buffers.", "magit")
  defface("magit-section-highlight", { bg: "#2a3340" }, "Face for the current Magit section.", "magit")
  defface("magit-section-heading", { bold: true, inherit: ["keyword"] }, "Face for Magit section headings.", "magit")
  defface("magit-section-secondary-heading", { inherit: ["magit-section-heading"] }, "Face for secondary Magit section headings.", "magit")
  defface("magit-section-heading-selection", { bg: "#3a4a5c", bold: true }, "Face for selected Magit section headings.", "magit")
  defface("magit-section-child-count", { inherit: ["comment"] }, "Face for Magit section child counts.", "magit")
  defface("magit-left-margin", { inherit: ["comment"] }, "Face for Magit section margins.", "magit")
}

function ensurePointKeymapSources(): void {
  if (!pointSourcesInstalled) {
    addPointKeymapSource(headingKeymapAtPoint)
    addPointKeymapSource(sectionKeymapAtPoint)
    pointSourcesInstalled = true
  }
}

function ensureHooks(): void {
  if (!getHooks("pre-command-hook").includes(magitSectionPreCommandHook)) addHook("pre-command-hook", magitSectionPreCommandHook)
  if (!getHooks("post-command-hook").includes(magitSectionPostCommandHook)) addHook("post-command-hook", magitSectionPostCommandHook)
}

let pointSourcesInstalled = false

function initializeSectionKeymaps(): void {
  if (sectionKeymapsInitialized) return
  sectionKeymapsInitialized = true
  magitSectionModeMap.bind("space", "magit-undefined")
  for (let c = 0x21; c <= 0x7e; c++) magitSectionModeMap.bind(String.fromCharCode(c), "magit-undefined")
  for (let c = 0x61; c <= 0x7a; c++) magitSectionModeMap.bind(`S-${String.fromCharCode(c)}`, "magit-undefined")
  magitSectionModeMap.bind("tab", "magit-section-toggle")
  magitSectionModeMap.bind("C-c tab", "magit-section-cycle")
  magitSectionModeMap.bind("C-tab", "magit-section-cycle")
  magitSectionModeMap.bind("M-tab", "magit-section-cycle")
  magitSectionModeMap.bind("S-tab", "magit-section-cycle-global")
  magitSectionModeMap.bind("backtab", "magit-section-cycle-global")
  magitSectionModeMap.bind("^", "magit-section-up")
  magitSectionModeMap.bind("p", "magit-section-backward")
  magitSectionModeMap.bind("n", "magit-section-forward")
  magitSectionModeMap.bind("M-p", "magit-section-backward-sibling")
  magitSectionModeMap.bind("M-n", "magit-section-forward-sibling")
  for (const level of [1, 2, 3, 4] as const) {
    magitSectionModeMap.bind(String(level), `magit-section-show-level-${level}`)
    magitSectionModeMap.bind(`M-${level}`, `magit-section-show-level-${level}-all`)
  }
}

let sectionKeymapsInitialized = false
initializeSectionKeymaps()

function headingKeymapAtPoint(buffer: BufferModel, point: number): Keymap | null {
  const section = sectionAt(buffer, point)
  if (!section?.parent || !sectionPositionInHeading(section, point)) return null
  return magitSectionHeadingMap
}

function sectionKeymapAtPoint(buffer: BufferModel, point: number): Keymap | null {
  let section = sectionAt(buffer, point)
  while (section?.parent) {
    if (section.keymap) return section.keymap
    const typeMap = sectionTypeKeymaps.get(section.type)
    if (typeMap) return typeMap
    section = section.parent
  }
  return null
}

function magitSectionPreCommandHook({ buffer }: { buffer: BufferModel }): void {
  const section = currentSection(buffer)
  buffer.locals.set(MAGIT_SECTION_PRE_COMMAND_IDENT_LOCAL, section ? sectionIdentKey(sectionIdent(section)) : null)
}

function magitSectionPostCommandHook({ editor, buffer }: { editor: Editor; buffer: BufferModel }): void | Promise<void> {
  const before = buffer.locals.get(MAGIT_SECTION_PRE_COMMAND_IDENT_LOCAL)
  const section = currentSection(buffer)
  const after = section ? sectionIdentKey(sectionIdent(section)) : null
  if (before !== after) return runHooks("magit-section-movement-hook", { editor, buffer })
}

function hiddenRanges(root: MagitSection, text: string): HiddenRange[] {
  const ranges: HiddenRange[] = []
  const visit = (section: MagitSection, hiddenAncestor: boolean) => {
    if (hiddenAncestor) return
    if (section.parent && section.hidden && section.content < section.end) {
      const headingNewline = section.content > section.start && text[section.content - 1] === "\n"
      const from = headingNewline ? section.content - 1 : section.content
      const needsNewline = section.end < text.length
      ranges.push({ from, to: section.end, replacement: needsNewline ? "...\n" : "..." })
      return
    }
    for (const child of section.children) visit(child, hiddenAncestor || section.hidden)
  }
  visit(root, false)
  return coalesceRanges(ranges).sort((a, b) => a.from - b.from)
}

function coalesceRanges(ranges: HiddenRange[]): HiddenRange[] {
  const sorted = ranges.sort((a, b) => a.from - b.from)
  const out: HiddenRange[] = []
  for (const range of sorted) {
    const prev = out[out.length - 1]
    if (prev && range.from <= prev.to) {
      prev.to = Math.max(prev.to, range.to)
    } else {
      out.push({ ...range })
    }
  }
  return out
}

function mapOffset(pieces: DisplayPiece[], n: number, textLength: number): number {
  for (const piece of pieces) {
    if (piece.kind === "visible") {
      if (n <= piece.to) return piece.displayStart + Math.max(0, n - piece.from)
    } else if (n <= piece.to) {
      return piece.displayStart + piece.replacementLength
    }
  }
  return textLength
}

function unmapOffset(pieces: DisplayPiece[], n: number, sourceLength: number): number {
  for (const piece of pieces) {
    if (piece.kind === "visible") {
      const end = piece.displayStart + (piece.to - piece.from)
      if (n <= end) return piece.from + Math.max(0, n - piece.displayStart)
    } else {
      const end = piece.displayStart + piece.replacementLength
      if (n <= end) return piece.from
    }
  }
  return sourceLength
}

function setSectionHidden(buffer: BufferModel, section: MagitSection, hidden: boolean): void {
  if (!section.parent) return
  section.hidden = hidden
  buffer.locals.delete(MAGIT_SECTION_FILTER_CACHE_LOCAL)
  maybeCacheVisibility(buffer, section)
}

function maybeCacheVisibility(buffer: BufferModel, section: MagitSection): void {
  const setting = getCustom<boolean | string[]>("magit-section-cache-visibility")
  if (setting === false) return
  if (Array.isArray(setting) && !setting.includes(section.type)) return
  visibilityCache(buffer).set(sectionIdentKey(sectionIdent(section)), section.hidden ? "hide" : "show")
}

function initialVisibility(section: MagitSection): MagitSectionVisibility | null {
  const entries = getCustom<MagitSectionInitialVisibilityEntry[]>("magit-section-initial-visibility-alist") ?? []
  for (const [match, visibility] of entries) {
    if (!sectionMatch(section, match)) continue
    if (typeof visibility === "function") return visibility(section) ?? null
    return visibility
  }
  return null
}

function runSectionWasher(buffer: BufferModel, section: MagitSection): void {
  const washer = section.washer
  if (!washer) return
  const oldEnd = section.end
  section.children = []
  const builder = new MagitSectionBuilder({ root: section, initialOffset: section.content, visibilityCache: visibilityCache(buffer) })
  washer(builder, section)
  const body = builder.toString()
  const wasReadOnly = buffer.readOnly
  buffer.readOnly = false
  buffer.splice(section.content, oldEnd, body, { markDirty: false, snapshot: false })
  buffer.readOnly = wasReadOnly
  const delta = section.end - oldEnd
  const root = rootSection(buffer)
  if (root && delta !== 0) adjustOffsetsAfter(root, oldEnd, delta, section)
  section.washer = null
}

function adjustOffsetsAfter(section: MagitSection, at: number, delta: number, skip: MagitSection): void {
  if (section === skip) return
  if (section.start >= at) section.start += delta
  if (section.content >= at) section.content += delta
  if (section.end >= at) section.end += delta
  for (const child of section.children) adjustOffsetsAfter(child, at, delta, skip)
}

function sectionDepth(section: MagitSection): number {
  let depth = 0
  for (let cur = section.parent; cur; cur = cur.parent) depth++
  return depth
}

function moveByVisibleSection(editor: Editor, buffer: BufferModel, count: number): boolean {
  const sections = visibleSections(buffer)
  if (!sections.length) return false
  const current = currentSection(buffer)
  const index = current ? sections.indexOf(current) : -1
  const fallback = count > 0 ? -1 : sections.length
  const next = Math.max(0, Math.min((index >= 0 ? index : fallback) + count, sections.length - 1))
  if (next === index) return false
  void gotoSection(editor, buffer, sections[next]!)
  return true
}

function moveBySibling(editor: Editor, buffer: BufferModel, count: number): boolean {
  const section = currentSection(buffer)
  if (!section?.parent) return false
  const siblings = sectionSiblings(section).filter(sibling => visibleSections(buffer).includes(sibling))
  const index = siblings.indexOf(section)
  const next = Math.max(0, Math.min(index + count, siblings.length - 1))
  if (index < 0 || next === index) return false
  void gotoSection(editor, buffer, siblings[next]!)
  return true
}

async function gotoSection(editor: Editor, buffer: BufferModel, section: MagitSection): Promise<void> {
  buffer.point = section.start
  editor.setSelectedWindowPoint(buffer.point)
  await editor.runHook("magit-section-movement-hook", buffer)
}

function prefixCount(prefix: unknown): number {
  if (typeof prefix === "number" && Number.isFinite(prefix)) return Math.max(1, Math.trunc(Math.abs(prefix)))
  return 1
}

function stableIdentValue(value: unknown): unknown {
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
  if (Array.isArray(value)) return value.map(stableIdentValue)
  if (typeof value === "object") {
    const object = value as Record<string, unknown>
    if ("ident" in object) return stableIdentValue(object.ident)
    if (typeof object.file === "string" && typeof object.staged === "boolean") {
      if (typeof object.patch === "string") return { file: object.file, staged: object.staged, patch: object.patch }
      return { file: object.file, staged: object.staged }
    }
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(object).sort()) {
      const entry = object[key]
      if (typeof entry !== "function") out[key] = stableIdentValue(entry)
    }
    return out
  }
  return String(value)
}
