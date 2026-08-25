/**
 * Public surface for eval/load — everything user config and plugins may redefine.
 */
export { Editor } from "../kernel/editor"
export { BufferModel } from "../kernel/buffer"
export { defcustom, defgroup, defineIcon, defvar, getCustom, setCustom, setCustomValue, saveCustom, resetCustom, resetCustomToSaved, patchCustom, restoreCustom, listCustomVariables, listCustomGroups, listCustomIcons, customSetVariables, customSetIcons } from "./custom"
export { currentKill, getKillRing, killNew, killRingIndex } from "./kill-ring"
export {
  defface,
  customSetFaces,
  setFaceAttribute,
  faceRemapAddRelative,
  faceRemapReset,
  composeTheme,
  getCustomFace,
  listCustomFaces,
  listKnownFaceNames,
  saveFace,
  resetFace,
  resetFaceToSaved,
} from "./faces"
export { defineMode, getMode, modeLineage, modes } from "../modes/mode"
export { addHook, removeHook, clearHooks, modeHookName } from "../kernel/hooks"
export { addAdvice, clearAdvice } from "./advice"
export { addToLoadPath, getLoadPath } from "./load-path"
export { registerKeyBinding } from "./key-registry"
export { defineTheme } from "../display/theme"
export { enableBuiltinTheme, registerTheme, themeSource } from "../themes"
