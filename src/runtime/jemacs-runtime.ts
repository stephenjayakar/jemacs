/**
 * Public surface for eval/load — everything user config and plugins may redefine.
 */
export { Editor } from "../kernel/editor"
export { BufferModel } from "../kernel/buffer"
export { defcustom, defvar, getCustom, setCustom, saveCustom, resetCustom, resetCustomToSaved, patchCustom, restoreCustom, listCustomVariables } from "./custom"
export { defineMode, getMode, modeLineage, modes } from "../modes/mode"
export { addHook, removeHook, clearHooks, modeHookName } from "../kernel/hooks"
export { addAdvice, clearAdvice } from "./advice"
export { addToLoadPath, getLoadPath } from "./load-path"
export { registerKeyBinding } from "./key-registry"
export { defineTheme } from "../display/theme"
export { registerTheme, themeSource } from "../themes"
