import { basename } from "node:path"
import type { Theme } from "../display/theme"
import { captureCallerSource } from "../runtime/source"
import { jemacsDarkTheme } from "./jemacs-dark"

export { jemacsDarkTheme } from "./jemacs-dark"

/** Registered themes keyed by name (for `load-theme`, Customize, config, and plugins). */
export const builtinThemes: Record<string, Theme> = {
  [jemacsDarkTheme.name]: jemacsDarkTheme,
}
const themeSources = new Map<string, string>([[jemacsDarkTheme.name, "built-in"]])
/** Defining file per theme — the analogue of Emacs's `NAME-theme.el`. */
const themeFiles = new Map<string, string>([[jemacsDarkTheme.name, "jemacs-dark.ts"]])

export function registerTheme(theme: Theme, source = "plugin"): Theme {
  builtinThemes[theme.name] = theme
  themeSources.set(theme.name, source)
  const file = captureCallerSource(3)?.file
  if (file) themeFiles.set(theme.name, basename(file))
  return theme
}

/** Basename of the file that registered THEME, if known. */
export function themeFile(name: string): string | undefined {
  return themeFiles.get(name)
}

export function getBuiltinTheme(name: string): Theme | undefined {
  return builtinThemes[name]
}

export function themeSource(name: string): string {
  return themeSources.get(name) ?? "plugin"
}

/** `custom-theme-summary`: the docstring's *first line*, or Emacs's placeholder. */
export function themeSummary(name: string): string {
  const doc = getBuiltinTheme(name)?.doc
  return doc ? doc.split("\n", 1)[0]! : "(no documentation available)"
}

const enabledThemes = new Set<string>()
let savedEnabledThemes: string[] = []

export function listBuiltinThemeNames(): string[] {
  return Object.keys(builtinThemes).sort()
}

export function enableBuiltinTheme(name: string): Theme | undefined {
  const theme = getBuiltinTheme(name)
  if (!theme) return undefined
  enabledThemes.add(name)
  return theme
}

export function disableBuiltinTheme(name: string): boolean {
  return enabledThemes.delete(name)
}

export function isBuiltinThemeEnabled(name: string): boolean {
  return enabledThemes.has(name)
}

export function listEnabledBuiltinThemes(): string[] {
  return [...enabledThemes]
}

export function saveEnabledBuiltinThemes(themes = listEnabledBuiltinThemes()): void {
  savedEnabledThemes = [...themes]
}

export function listSavedBuiltinThemes(): string[] {
  return [...savedEnabledThemes]
}

/** Default when no user theme is configured. */
export const defaultTheme = jemacsDarkTheme
