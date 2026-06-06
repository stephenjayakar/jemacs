import { registerCatalogEntry } from "./definitions"
import type { SourceLocation } from "./source"
import { captureCallerSource } from "./source"

export type CustomType = "boolean" | "string" | "number" | "sexp"

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
}

const variables = new Map<string, CustomVariable>()

export function defcustom<T>(name: string, type: CustomType, value: T, doc?: string, group?: string): CustomVariable<T> {
  const existing = variables.get(name)
  if (existing) return existing as CustomVariable<T>
  const source = captureCallerSource(3)
  const variable: CustomVariable<T> = { name, type, value, doc, group, source, baselineValue: value, patched: false }
  variables.set(name, variable as CustomVariable)
  registerCatalogEntry({ kind: "variable", name, source, doc, patched: false })
  return variable
}

export function defvar<T>(name: string, value: T, doc?: string, group?: string): CustomVariable<T> {
  const existing = variables.get(name)
  if (existing) return existing as CustomVariable<T>
  const type: CustomType = typeof value === "boolean"
    ? "boolean"
    : typeof value === "number"
      ? "number"
      : typeof value === "object"
        ? "sexp"
        : "string"
  return defcustom(name, type, value, doc, group)
}

export function getCustom<T>(name: string): T | undefined {
  return variables.get(name)?.value as T | undefined
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
  variable.customized = true
  registerCatalogEntry({ kind: "variable", name, source: variable.source, patched: variable.patched, doc: variable.doc })
}

export function resetCustom(name: string): boolean {
  const variable = variables.get(name)
  if (!variable) return false
  const baseline = variable.baselineValue
  if (baseline === undefined) return false
  variable.value = baseline
  variable.customized = false
  variable.savedValue = undefined
  registerCatalogEntry({ kind: "variable", name, source: variable.source, patched: variable.patched, doc: variable.doc })
  return true
}

export function resetCustomToSaved(name: string): boolean {
  const variable = variables.get(name)
  if (!variable || variable.savedValue === undefined) return false
  variable.value = variable.savedValue
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
