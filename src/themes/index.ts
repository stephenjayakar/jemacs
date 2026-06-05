import type { Theme } from "../display/theme"
import { jemacsDarkTheme } from "./jemacs-dark"

export { jemacsDarkTheme } from "./jemacs-dark"

/** Registered themes keyed by name (for `load-theme`, Customize, config, and plugins). */
export const builtinThemes: Record<string, Theme> = {
  [jemacsDarkTheme.name]: jemacsDarkTheme,
}
const themeSources = new Map<string, string>([[jemacsDarkTheme.name, "built-in"]])

export function registerTheme(theme: Theme, source = "plugin"): Theme {
  builtinThemes[theme.name] = theme
  themeSources.set(theme.name, source)
  return theme
}

export function getBuiltinTheme(name: string): Theme | undefined {
  return builtinThemes[name]
}

export function themeSource(name: string): string {
  return themeSources.get(name) ?? "plugin"
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
