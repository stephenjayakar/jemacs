/**
 * Value widgets for Custom buffers — the `wid-edit.el` half of customize.
 *
 * Each `defcustom :type` maps to a widget that knows how to print itself, which
 * parts of the printed text are editable fields, and how to read a value back.
 * The layout follows what GNU Emacs 30 prints in `*Customize Option: …*`:
 *
 *     Hide W Integer: Integer: 8
 *     Hide W Choice: Choice: [Value Menu] alpha
 *     Hide W Repeat:
 *     Repeat:
 *     [INS] [DEL] String: a
 *     [INS]
 */
import {
  customTypeLabel,
  isCompositeType,
  type CustomChoice,
  type CustomType,
} from "../runtime/custom"

/** Address of a sub-value inside a composite widget value. A face attribute
 *  row roots its path at `["attr", KEY]`, so every field in the buffer has a
 *  single addressing scheme regardless of which widget owns it. */
export type ValuePath = Array<number | "key" | "value" | "attr" | string>

export function pathKey(path: ValuePath): string {
  return path.join("\u0000")
}

/** The type of the sub-value at PATH, or undefined if PATH does not apply. */
export function typeAtPath(type: CustomType, path: ValuePath, value: unknown): CustomType | undefined {
  if (!path.length) return type
  const [head, ...rest] = path
  if (!isCompositeType(type)) return undefined
  switch (type.kind) {
    case "repeat":
      return typeof head === "number" ? typeAtPath(type.item, rest, elementAt(value, head)) : undefined
    case "hook":
      return typeof head === "number" ? typeAtPath("function", rest, elementAt(value, head)) : undefined
    case "alist": {
      if (typeof head !== "number") return undefined
      const [next, ...tail] = rest
      const pair = elementAt(value, head)
      if (next === "key") return typeAtPath(type.key, tail, Array.isArray(pair) ? pair[0] : undefined)
      if (next === "value") return typeAtPath(type.value, tail, Array.isArray(pair) ? pair[1] : undefined)
      return undefined
    }
    case "choice": {
      const arm = chosenArm(type, value)
      return arm && "type" in arm ? typeAtPath(arm.type, path, value) : undefined
    }
    case "list":
      return typeof head === "number"
        ? typeAtPath(type.items[head] ?? "sexp", rest, elementAt(value, head))
        : undefined
    case "plist": {
      if (typeof head !== "number") return undefined
      const [next, ...tail] = rest
      const pair = elementAt(value, head)
      if (next === "key" || next === "value") {
        return typeAtPath("symbol", tail, Array.isArray(pair) ? pair[next === "key" ? 0 : 1] : undefined)
      }
      return undefined
    }
    case "record":
      return typeof head === "string"
        ? typeAtPath(type.members[head] ?? "sexp", rest, elementAt(value, head as never))
        : undefined
    case "set":
      return undefined
  }
}

function elementAt(value: unknown, index: number | string): unknown {
  if (typeof index === "string") {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[index] : undefined
  }
  return Array.isArray(value) ? value[index] : undefined
}

/** Which `choice` arm currently matches VALUE (cus-edit.el `:value-to-internal`). */
export function chosenArm(
  type: { options: CustomChoice[] },
  value: unknown,
): CustomChoice | undefined {
  const constArm = type.options.find(option => "const" in option && deepEqual(option.const, value))
  if (constArm) return constArm
  // A `FloatValue` says the writer meant Emacs's float, which picks the
  // `number` arm even when the magnitude happens to be integral.
  if (isFloatValue(value)) {
    const numberArm = type.options.find(option => "type" in option && option.type === "number")
    if (numberArm) return numberArm
  }
  return type.options.find(option => "type" in option && valueMatchesType(option.type, value))
}

/** Emacs distinguishes the integer `1` from the float `1.0`; JavaScript does
 *  not. A value boxed this way is the float, which matters where a `choice`
 *  offers an integer arm and a float arm (`:height` is the only such case). */
export class FloatValue {
  constructor(readonly value: number) {}
  toString(): string {
    return Number.isInteger(this.value) ? `${this.value}.0` : String(this.value)
  }
}

export function isFloatValue(value: unknown): value is FloatValue {
  return value instanceof FloatValue
}

export function unboxFloat(value: unknown): unknown {
  return isFloatValue(value) ? value.value : value
}

export function choiceLabel(option: CustomChoice): string {
  if (option.tag) return option.tag
  if ("const" in option) return formatScalar(option.const)
  return customTypeLabel(option.type)
}

function valueMatchesType(type: CustomType, value: unknown): boolean {
  if (isCompositeType(type)) {
    switch (type.kind) {
      case "repeat": case "hook": case "set": return Array.isArray(value)
      case "alist": case "list": case "plist": return Array.isArray(value)
      case "record": return typeof value === "object" && value !== null
      case "choice": return chosenArm(type, value) != null
    }
  }
  switch (type) {
    case "boolean": return typeof value === "boolean"
    case "integer": case "natnum": return typeof value === "number" && Number.isInteger(value)
    case "number": return typeof value === "number" || isFloatValue(value)
    case "string": case "regexp": case "file": case "directory":
    case "symbol": case "function": case "face": case "color": return typeof value === "string"
    case "sexp": return true
  }
}

/** Print a scalar the way its widget's editable field shows it. */
export function formatScalar(value: unknown): string {
  if (value == null) return ""
  if (typeof value === "string") return value
  if (typeof value === "boolean") return value ? "t" : "nil"
  if (typeof value === "number") return String(value)
  return JSON.stringify(value)
}

export function formatValue(type: CustomType, value: unknown): string {
  if (type === "sexp" || isCompositeType(type)) return JSON.stringify(value ?? null)
  if (type === "boolean") return value ? "true" : "false"
  if (isFloatValue(value)) return value.toString()
  return formatScalar(value)
}

export function parseValue(type: CustomType, text: string): unknown {
  if (isCompositeType(type)) {
    try { return JSON.parse(text) } catch { throw new Error(`Invalid JSON: ${text}`) }
  }
  switch (type) {
    case "boolean": {
      const value = text.trim().toLowerCase()
      return !["nil", "false", "0", "no", "off", ""].includes(value)
    }
    case "integer":
    case "natnum": {
      const value = Number(text.trim())
      if (!Number.isFinite(value) || !Number.isInteger(value)) throw new Error(`Invalid integer: ${text}`)
      if (type === "natnum" && value < 0) throw new Error(`Invalid integer (positive or zero): ${text}`)
      return value
    }
    case "number": {
      const value = Number(text.trim())
      if (Number.isNaN(value)) throw new Error(`Invalid number: ${text}`)
      return value
    }
    case "sexp":
      try { return JSON.parse(text) } catch { throw new Error(`Invalid JSON: ${text}`) }
    default:
      return text
  }
}

/** The value a freshly inserted `[INS]` element starts with. */
export function defaultValue(type: CustomType): unknown {
  if (isCompositeType(type)) {
    switch (type.kind) {
      case "repeat": case "hook": case "set": return []
      case "alist": case "plist": return []
      case "list": return type.items.map(defaultValue)
      case "record": return {}
      case "choice": {
        const first = type.options[0]
        if (!first) return null
        return "const" in first ? first.const : defaultValue(first.type)
      }
    }
  }
  switch (type) {
    case "boolean": return false
    case "integer": case "natnum": case "number": return 0
    case "sexp": return null
    default: return ""
  }
}

/** A path step is an array index (`0`, `"key"`, `"value"`) or, for a face
 *  attribute row, the string key of a plain record. */
function stepIsIndex(step: ValuePath[number]): boolean {
  return typeof step === "number" || step === "key" || step === "value"
}

function indexOfStep(step: ValuePath[number]): number {
  return step === "key" ? 0 : step === "value" ? 1 : (step as number)
}

export function getAtPath(value: unknown, path: ValuePath): unknown {
  let current = value
  for (const step of path) {
    if (current == null) return undefined
    if (stepIsIndex(step)) {
      current = Array.isArray(current) ? current[indexOfStep(step)] : undefined
    } else {
      current = typeof current === "object" ? (current as Record<string, unknown>)[step as string] : undefined
    }
  }
  return current
}

/** Functional deep-set: returns a copy of VALUE with PATH replaced. */
export function setAtPath(value: unknown, path: ValuePath, next: unknown): unknown {
  if (!path.length) return next
  const [head, ...rest] = path
  if (!stepIsIndex(head!)) {
    const record = (typeof value === "object" && value !== null && !Array.isArray(value))
      ? { ...(value as Record<string, unknown>) }
      : {}
    record[head as string] = setAtPath(record[head as string], rest, next)
    return record
  }
  const index = indexOfStep(head!)
  const array = Array.isArray(value) ? [...value] : []
  while (array.length <= index) array.push(undefined)
  array[index] = setAtPath(array[index], rest, next)
  return array
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a == null || b == null) return false
  if (typeof a !== "object" || typeof b !== "object") return false
  try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
}

/** cus-edit.el `:custom-show`: does the widget render inline in a multi-item
 *  buffer, or collapse to `Show Value NAME`? Only booleans and choices do. */
export function widgetShowsInline(type: CustomType): boolean {
  if (isCompositeType(type)) return type.kind === "choice"
  return type === "boolean"
}

/** Does the widget print its value on the heading line, or on lines below it? */
export function widgetIsMultiLine(type: CustomType): boolean {
  return isCompositeType(type) && type.kind !== "choice"
}
