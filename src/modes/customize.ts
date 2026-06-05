import type { Editor } from "../kernel/editor"
import { Keymap } from "../kernel/keymap"
import { defineMode, getMode } from "./mode"
import {
  getCustomVariable,
  getCustom,
  listCustomVariables,
  resetCustom,
  resetCustomToSaved,
  saveCustom,
  setCustom,
  type CustomType,
  type CustomVariable,
} from "../runtime/custom"
import {
  enableBuiltinTheme,
  defaultTheme,
  disableBuiltinTheme,
  getBuiltinTheme,
  isBuiltinThemeEnabled,
  listBuiltinThemeNames,
  listEnabledBuiltinThemes,
  listSavedBuiltinThemes,
  saveEnabledBuiltinThemes,
  themeSource,
} from "../themes"

export const CUSTOMIZE_VARIABLE_KEY = "jemacs-customize-variable"
export const CUSTOMIZE_THEME_KEY = "jemacs-customize-theme"

export function installCustomizeMode(): void {
  const keymap = new Keymap("customize-mode-map")
  for (const key of ["return", "enter", "RET"]) keymap.bind(key, "customize-set")
  keymap.bind("s", "customize-set")
  keymap.bind("S-s", "customize-save")
  keymap.bind("C-c C-c", "Custom-set")
  keymap.bind("C-x C-s", "Custom-save")
  keymap.bind("r", "customize-reset")
  keymap.bind("u", "customize-reset-saved")
  keymap.bind("d", "customize-describe")
  keymap.bind("g", "customize-refresh")
  keymap.bind("n", "widget-forward")
  keymap.bind("p", "widget-backward")
  keymap.bind("q", "Custom-buffer-done")
  defineMode({ name: "customize-mode", parent: "text", keymap })

  const themeKeymap = new Keymap("custom-theme-choose-mode-map")
  for (const key of ["return", "enter", "RET", "space"]) themeKeymap.bind(key, "customize-theme-toggle")
  themeKeymap.bind("?", "customize-theme-describe")
  themeKeymap.bind("s", "customize-themes-save")
  themeKeymap.bind("S-s", "customize-themes-save")
  themeKeymap.bind("C-x C-s", "customize-themes-save")
  themeKeymap.bind("g", "customize-refresh")
  themeKeymap.bind("n", "widget-forward")
  themeKeymap.bind("p", "widget-backward")
  themeKeymap.bind("q", "Custom-buffer-done")
  defineMode({ name: "custom-theme-choose-mode", parent: "text", keymap: themeKeymap })
}

export function installCustomizeCommands(editor: Editor): void {
  if (!getMode("customize-mode")) installCustomizeMode()

  editor.command("customize", ({ editor }) => {
    showCustomizeBuffer(editor, listCustomVariables(), "Customize Jemacs")
  }, "Select a customization buffer which you can use to set user options.")

  editor.command("customize-group", async ({ editor, args }) => {
    const group = args[0] ?? await editor.completingRead("Customize group: ", {
      collection: customizeGroups(),
      history: "customize-group",
      initialValue: "jemacs",
    })
    if (!group) return
    showCustomizeBuffer(editor, variablesForGroup(group), `Customize Group: ${group}`)
  }, "Customize GROUP, which must be a customization group.")

  editor.command("customize-group-other-window", async ctx => {
    await ctx.editor.run("customize-group", ctx.args)
    showCurrentBufferInOtherWindow(ctx.editor)
  }, "Customize GROUP in another window.")

  editor.command("customize-variable", async ({ editor, args }) => {
    const name = args[0] ?? await editor.completingRead("Customize variable: ", {
      collection: listCustomVariables().map(variable => variable.name),
      history: "variable",
    })
    if (!name) return
    const variable = getCustomVariable(name)
    if (!variable) {
      editor.message(`No user option named ${name}`)
      return
    }
    showCustomizeBuffer(editor, [variable], `Customize Option: ${name}`)
  }, "Customize SYMBOL, which must be a user option.")

  editor.command("customize-variable-other-window", async ctx => {
    await ctx.editor.run("customize-variable", ctx.args)
    showCurrentBufferInOtherWindow(ctx.editor)
  }, "Customize SYMBOL in another window.")

  editor.command("customize-option", async ctx => {
    await ctx.editor.run("customize-variable", ctx.args)
  }, "Customize SYMBOL, which must be a user option.")

  editor.command("customize-option-other-window", async ctx => {
    await ctx.editor.run("customize-variable-other-window", ctx.args)
  }, "Customize SYMBOL in another window.")

  editor.command("customize-set-variable", async ({ editor, args }) => {
    await customizeSetVariable(editor, args, false)
  }, "Set the default for VARIABLE to VALUE.")

  editor.command("customize-set-value", async ({ editor, args }) => {
    await customizeSetVariable(editor, args, false)
  }, "Set VARIABLE to VALUE.")

  editor.command("customize-save-variable", async ({ editor, args }) => {
    await customizeSetVariable(editor, args, true)
  }, "Set VARIABLE to VALUE and save it for future sessions.")

  editor.command("customize-save-customized", ({ editor }) => {
    const variables = listCustomVariables().filter(variable => variable.customized)
    for (const variable of variables) saveCustom(variable.name)
    editor.message(`Saved ${variables.length} customized option${variables.length === 1 ? "" : "s"}`)
    refreshCustomizeBuffer(editor)
  }, "Save all user options which have been set in this session.")

  editor.command("customize-customized", ({ editor }) => {
    showCustomizeBuffer(editor, listCustomVariables().filter(variable => variable.customized), "Customize Customized Options")
  }, "Customize all options set in this session but not saved.")

  editor.command("customize-unsaved", ({ editor }) => {
    showCustomizeBuffer(editor, listCustomVariables().filter(isUnsavedCustom), "Customize Unsaved Options")
  }, "Customize all options set in this session but not saved.")

  editor.command("customize-saved", ({ editor }) => {
    showCustomizeBuffer(editor, listCustomVariables().filter(variable => variable.savedValue !== undefined), "Customize Saved Options")
  }, "Customize all saved options.")

  editor.command("customize-rogue", ({ editor }) => {
    showCustomizeBuffer(editor, listCustomVariables().filter(variable => variable.patched), "Customize Rogue Options")
  }, "Customize user variables modified outside Customize.")

  editor.command("customize-changed", ({ editor }) => {
    showCustomizeBuffer(editor, listCustomVariables(), "Customize Changed Options")
  }, "Customize settings whose meanings have changed.")

  editor.command("customize-changed-options", async ctx => {
    await ctx.editor.run("customize-changed", ctx.args)
  }, "Customize settings whose meanings have changed.")

  editor.command("customize-mode", async ({ editor, args }) => {
    const mode = args[0] ?? await editor.completingRead("Customize mode: ", {
      collection: customizeGroups(),
      history: "customize-mode",
      initialValue: editor.currentBuffer.mode,
    })
    if (!mode) return
    const group = mode.endsWith("-mode") ? mode.slice(0, -"mode".length).replace(/-$/, "") : mode
    showCustomizeBuffer(editor, variablesForGroup(group), `Customize Mode: ${mode}`)
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
    await showCustomizeFaces(editor, args[0])
  }, "Customize FACE, which should be a face name or nil.")

  editor.command("customize-face-other-window", async ctx => {
    await ctx.editor.run("customize-face", ctx.args)
    showCurrentBufferInOtherWindow(ctx.editor)
  }, "Show customization buffer for FACE in other window.")

  editor.command("customize-icon", ({ editor, args }) => {
    editor.message(args[0] ? `No customizable icon named ${args[0]}` : "No customizable icons are registered")
  }, "Customize ICON.")

  editor.command("custom-toggle-hide-all-widgets", ({ editor }) => {
    editor.message("All Customize widgets are shown in compact Jemacs form")
  }, "Hide or show details of all customizable settings in a Custom buffer.")

  editor.command("customize-browse", async ({ editor, args }) => {
    const group = args[0]
    const groups = customizeGroups().filter(candidate => !group || candidate === group || candidate.includes(group))
    const lines = ["Customize Browse", "", ...groups.map(candidate => `Group: ${candidate}`)]
    editor.scratch("*Customize Browse*", lines.join("\n"), "customize-mode")
  }, "Create a tree browser for the customize hierarchy.")

  editor.command("custom-buffer-create", ({ editor }) => {
    showCustomizeBuffer(editor, listCustomVariables(), "Customize")
  }, "Create a Customize buffer.")

  editor.command("customize-themes", ({ editor }) => {
    showCustomizeThemesBuffer(editor)
  }, "Display a selectable list of Custom themes.")

  editor.command("customize-theme-toggle", ({ editor }) => {
    const name = customizeThemeAtPoint(editor)
    if (!name) {
      editor.message("No theme on this line")
      return
    }
    toggleTheme(editor, name)
    refreshCustomizeBuffer(editor)
  }, "Toggle the Custom theme at point.")

  editor.command("customize-theme-describe", ({ editor }) => {
    const name = customizeThemeAtPoint(editor)
    if (!name) {
      editor.message("No theme on this line")
      return
    }
    const theme = getBuiltinTheme(name)
    const faces = Object.keys(theme?.faces ?? {}).sort()
    editor.scratch("*Help*", [
      `${name} theme`,
      "",
      `${themeSource(name)} Custom theme.`,
      "",
      `Faces: ${faces.join(", ")}`,
    ].join("\n"), "help")
  }, "Describe the Custom theme at point.")

  editor.command("customize-themes-save", ({ editor }) => {
    saveEnabledBuiltinThemes()
    refreshCustomizeBuffer(editor)
    const count = listSavedBuiltinThemes().length
    editor.message(`Saved ${count} enabled theme${count === 1 ? "" : "s"}`)
  }, "Save selected Custom themes.")

  editor.command("custom-theme-visit-theme", ({ editor, args }) => {
    const name = args[0]
    if (!name || !getBuiltinTheme(name)) {
      editor.message(name ? `Unknown theme: ${name}` : "No theme specified")
      return
    }
    showCustomizeThemesBuffer(editor, [name], `Custom Theme: ${name}`)
  }, "Set up a Custom buffer to edit custom theme THEME.")

  editor.command("customize-create-theme", ({ editor, args }) => {
    const name = args[0]
    if (name && getBuiltinTheme(name)) showCustomizeThemesBuffer(editor, [name], `Custom Theme: ${name}`)
    else editor.scratch("*Custom Theme*", "Custom theme creation is not implemented for new themes.\n", "custom-theme-choose-mode")
  }, "Create or edit a custom theme.")

  editor.command("customize-set", async ({ editor }) => {
    const variable = customizeVariableAtPoint(editor)
    if (!variable) {
      editor.message("No custom option on this line")
      return
    }
    const value = await readCustomValue(editor, variable)
    if (value == null) return
    setCustom(variable.name, value)
    refreshCustomizeBuffer(editor)
    editor.message(`Set ${variable.name}`)
  }, "Set the custom option at point for this session.")

  editor.command("Custom-set", async ctx => {
    if (ctx.editor.currentBuffer.mode === "custom-theme-choose-mode") await ctx.editor.run("customize-theme-toggle")
    else await ctx.editor.run("customize-set")
  }, "Set the customization at point.")

  editor.command("customize-save", async ({ editor }) => {
    const variable = customizeVariableAtPoint(editor)
    if (!variable) {
      editor.message("No custom option on this line")
      return
    }
    const value = await readCustomValue(editor, variable)
    if (value == null) return
    saveCustom(variable.name, value)
    refreshCustomizeBuffer(editor)
    editor.message(`Saved ${variable.name}`)
  }, "Set and save the custom option at point.")

  editor.command("Custom-save", async ctx => {
    if (ctx.editor.currentBuffer.mode === "custom-theme-choose-mode") await ctx.editor.run("customize-themes-save")
    else await ctx.editor.run("customize-save")
  }, "Save the customization at point.")

  editor.command("customize-reset", ({ editor }) => {
    const variable = customizeVariableAtPoint(editor)
    if (!variable) {
      editor.message("No custom option on this line")
      return
    }
    if (!resetCustom(variable.name)) editor.message(`Could not reset ${variable.name}`)
    else {
      refreshCustomizeBuffer(editor)
      editor.message(`Reset ${variable.name} to standard value`)
    }
  }, "Reset the custom option at point to its standard value.")

  editor.command("customize-reset-saved", ({ editor }) => {
    const variable = customizeVariableAtPoint(editor)
    if (!variable) {
      editor.message("No custom option on this line")
      return
    }
    if (!resetCustomToSaved(variable.name)) editor.message(`${variable.name} has no saved value`)
    else {
      refreshCustomizeBuffer(editor)
      editor.message(`Reset ${variable.name} to saved value`)
    }
  }, "Reset the custom option at point to its saved value.")

  editor.command("customize-describe", async ({ editor }) => {
    const variable = customizeVariableAtPoint(editor)
    if (!variable) {
      editor.message("No custom option on this line")
      return
    }
    await editor.run("describe-variable", [variable.name])
  }, "Describe the custom option at point.")

  editor.command("customize-refresh", ({ editor }) => {
    refreshCustomizeBuffer(editor)
    editor.message("Refreshed customize buffer")
  }, "Refresh the current customize buffer.")

  editor.command("widget-forward", ({ buffer }) => {
    moveToNextEntry(buffer, 1)
  }, "Move point to the next Customize widget.")

  editor.command("widget-backward", ({ buffer }) => {
    moveToNextEntry(buffer, -1)
  }, "Move point to the previous Customize widget.")

  editor.command("Custom-buffer-done", async ({ editor }) => {
    await editor.run("quit-window")
  }, "Exit the current Custom buffer.")
}

function showCustomizeBuffer(editor: Editor, variables: CustomVariable[], title: string): void {
  const body = formatCustomizeBuffer(title, variables)
  const buffer = editor.scratch("*Customize*", body, "customize-mode")
  buffer.readOnly = true
  buffer.locals.set(CUSTOMIZE_VARIABLE_KEY, variables.map(variable => variable.name))
  buffer.locals.delete(CUSTOMIZE_THEME_KEY)
  buffer.point = body.indexOf("Variable: ")
  if (buffer.point < 0) buffer.point = 0
}

function refreshCustomizeBuffer(editor: Editor): void {
  const themes = editor.currentBuffer.locals.get(CUSTOMIZE_THEME_KEY) as string[] | undefined
  if (themes) {
    const title = editor.currentBuffer.text.split("\n", 1)[0] || "Custom Themes"
    showCustomizeThemesBuffer(editor, themes, title)
    return
  }
  const names = editor.currentBuffer.locals.get(CUSTOMIZE_VARIABLE_KEY) as string[] | undefined
  const title = editor.currentBuffer.text.split("\n", 1)[0] || "Customize Jemacs"
  const variables = names?.map(name => getCustomVariable(name)).filter((v): v is CustomVariable => Boolean(v))
    ?? listCustomVariables()
  showCustomizeBuffer(editor, variables, title)
}

function formatCustomizeBuffer(title: string, variables: CustomVariable[]): string {
  const lines = [
    title,
    "",
    "Keys: RET/s set, S save, r reset, u reset-saved, d describe, g refresh",
    "",
  ]
  if (!variables.length) {
    lines.push("No custom options match.")
    return lines.join("\n")
  }
  for (const variable of variables) {
    lines.push(
      `Variable: ${variable.name}`,
      `  Value: ${JSON.stringify(variable.value)}`,
      `  Type: ${variable.type}`,
      `  State: ${customState(variable)}`,
    )
    if (variable.doc) lines.push(`  ${variable.doc}`)
    lines.push("")
  }
  return lines.join("\n")
}

function showCustomizeThemesBuffer(editor: Editor, themeNames = listBuiltinThemeNames(), title = "Custom Themes"): void {
  const body = formatCustomizeThemesBuffer(title, themeNames)
  const buffer = editor.scratch("*Custom Themes*", body, "custom-theme-choose-mode")
  buffer.readOnly = true
  buffer.locals.set(CUSTOMIZE_THEME_KEY, themeNames)
  buffer.locals.delete(CUSTOMIZE_VARIABLE_KEY)
  buffer.point = body.indexOf("Theme: ")
  if (buffer.point < 0) buffer.point = 0
}

function formatCustomizeThemesBuffer(title: string, themeNames: string[]): string {
  const enabled = new Set(listEnabledBuiltinThemes())
  const saved = new Set(listSavedBuiltinThemes())
  const lines = [
    title,
    "",
    "Keys: RET/space toggle, S save selected themes, g refresh, n/p move, q quit",
    "",
  ]
  if (!themeNames.length) {
    lines.push("No Custom themes match.")
    return lines.join("\n")
  }
  for (const name of themeNames) {
    const state = enabled.has(name) ? "enabled" : "disabled"
    const savedState = saved.has(name) ? ", saved" : ""
    lines.push(
      `Theme: ${name} [${enabled.has(name) ? "X" : " "}]`,
      `  State: ${state}${savedState}`,
      `  Source: ${themeSource(name)}`,
      "",
    )
  }
  return lines.join("\n")
}

function customState(variable: CustomVariable): string {
  if (variable.patched) return "CHANGED outside Customize"
  if (variable.savedValue !== undefined && Object.is(variable.value, variable.savedValue)) return "SAVED and set"
  if (variable.customized) return "SET for current session"
  return "STANDARD"
}

function customizeVariableAtPoint(editor: Editor): CustomVariable | null {
  const line = editor.currentBuffer.lineBoundsAt().text
  const direct = /^Variable:\s+(.+)$/.exec(line)?.[1]
  if (direct) return getCustomVariable(direct.trim()) ?? null

  const before = editor.currentBuffer.text.slice(0, editor.currentBuffer.point)
  const matches = [...before.matchAll(/^Variable:\s+(.+)$/gm)]
  const name = matches.at(-1)?.[1]?.trim()
  return name ? getCustomVariable(name) ?? null : null
}

function customizeThemeAtPoint(editor: Editor): string | null {
  const line = editor.currentBuffer.lineBoundsAt().text
  const direct = /^Theme:\s+(.+?)\s+\[/.exec(line)?.[1]
  if (direct && getBuiltinTheme(direct.trim())) return direct.trim()

  const before = editor.currentBuffer.text.slice(0, editor.currentBuffer.point)
  const matches = [...before.matchAll(/^Theme:\s+(.+?)\s+\[/gm)]
  const name = matches.at(-1)?.[1]?.trim()
  return name && getBuiltinTheme(name) ? name : null
}

async function customizeSetVariable(editor: Editor, args: string[], save: boolean): Promise<void> {
  const name = args[0] ?? await editor.completingRead(save ? "Customize save variable: " : "Customize set variable: ", {
    collection: listCustomVariables().map(variable => variable.name),
    history: "variable",
  })
  if (!name) return
  const variable = getCustomVariable(name)
  if (!variable) {
    editor.message(`No user option named ${name}`)
    return
  }
  const raw = args.length >= 2 ? args[1]! : await editor.prompt(`Set ${name}: `, String(getCustom(name)), `customize-${name}`)
  if (raw == null) return
  const value = parseCustomValue(variable.type, raw)
  if (save) {
    saveCustom(name, value)
    editor.message(`Saved ${name}`)
  } else {
    setCustom(name, value)
    editor.message(`Set ${name}`)
  }
  refreshCustomizeBuffer(editor)
}

async function customizeApropos(editor: Editor, args: string[], type: "all" | "options" | "groups" | "faces"): Promise<void> {
  const pattern = args[0] ?? await editor.prompt("Customize apropos: ", "", "customize-apropos")
  if (!pattern) return
  const re = new RegExp(pattern, "i")
  if (type === "groups") {
    const groups = customizeGroups().filter(group => re.test(group))
    const lines = ["Customize Apropos Groups", "", ...groups.map(group => `Group: ${group}`)]
    editor.scratch("*Customize Apropos*", lines.join("\n") || "No groups match.", "customize-mode")
    return
  }
  if (type === "faces") {
    await showCustomizeFaces(editor, pattern)
    return
  }
  const variables = listCustomVariables().filter(variable =>
    re.test(variable.name) || re.test(variable.doc ?? "") || re.test(groupForVariable(variable.name))
  )
  showCustomizeBuffer(editor, variables, `Customize Apropos${type === "options" ? " Options" : ""}: ${pattern}`)
}

async function showCustomizeFaces(editor: Editor, pattern?: string): Promise<void> {
  const theme = editor.theme
  const names = Object.keys(theme.faces).sort()
  const re = pattern ? new RegExp(pattern, "i") : null
  const filtered = re ? names.filter(name => re.test(name)) : names
  const lines = [
    pattern ? `Customize Faces: ${pattern}` : "Customize Faces",
    "",
    "Face editing is represented by the active theme face table.",
    "",
    ...filtered.map(name => `Face: ${name}\n  Value: ${JSON.stringify(theme.faces[name as keyof typeof theme.faces])}`),
  ]
  editor.scratch("*Customize Faces*", lines.join("\n") || "No faces match.", "customize-mode")
}

function toggleTheme(editor: Editor, name: string): void {
  if (isBuiltinThemeEnabled(name)) {
    disableBuiltinTheme(name)
    const active = listEnabledBuiltinThemes().at(-1)
    editor.setTheme(active ? getBuiltinTheme(active)! : defaultTheme)
    editor.message(`Disabled theme ${name}`)
    return
  }
  const theme = enableBuiltinTheme(name)
  if (!theme) {
    editor.message(`Unknown theme: ${name}`)
    return
  }
  editor.setTheme(theme)
  editor.message(`Enabled theme ${name}`)
}

async function readCustomValue(editor: Editor, variable: CustomVariable): Promise<unknown | null> {
  const initial = String(variable.value)
  const text = await editor.prompt(`Set ${variable.name}: `, initial, `customize-${variable.name}`)
  if (text == null) return null
  return parseCustomValue(variable.type, text)
}

function parseCustomValue(type: CustomType, text: string): unknown {
  if (type === "boolean") {
    const value = text.trim().toLowerCase()
    return !["nil", "false", "0", "no", "off"].includes(value)
  }
  if (type === "number") {
    const value = Number(text.trim())
    if (Number.isNaN(value)) throw new Error(`Invalid number: ${text}`)
    return value
  }
  return text
}

function customizeGroups(): string[] {
  const groups = new Set<string>(["jemacs"])
  for (const variable of listCustomVariables()) groups.add(groupForVariable(variable.name))
  return [...groups].sort()
}

function variablesForGroup(group: string): CustomVariable[] {
  if (group === "jemacs" || group === "emacs") return listCustomVariables()
  return listCustomVariables().filter(variable => groupForVariable(variable.name) === group)
}

function groupForVariable(name: string): string {
  const match = /^([^-]+)-/.exec(name)
  return match?.[1] ?? "jemacs"
}

function isUnsavedCustom(variable: CustomVariable): boolean {
  if (!variable.customized) return false
  if (variable.savedValue === undefined) return true
  return !Object.is(variable.value, variable.savedValue)
}

function moveToNextEntry(buffer: { text: string; point: number }, direction: 1 | -1): void {
  const pattern = /^(Variable|Theme|Face|Group):\s+/gm
  const entries = [...buffer.text.matchAll(pattern)].map(match => match.index ?? 0)
  if (!entries.length) return
  if (direction > 0) {
    buffer.point = entries.find(index => index > buffer.point) ?? entries[0]!
    return
  }
  buffer.point = [...entries].reverse().find(index => index < buffer.point) ?? entries.at(-1)!
}

function showCurrentBufferInOtherWindow(editor: Editor): void {
  const current = editor.currentBuffer
  editor.displayBufferInOtherWindow(current.id)
}
