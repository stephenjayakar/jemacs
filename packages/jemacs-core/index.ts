// Public surface of @jemacs/core. Re-exports the host-agnostic layers only:
// src/kernel/*, src/runtime/*, and src/display/{protocol,theme}. Host bootstrap
// (run/runJemacs), lisp/, and plugins/ are intentionally NOT part of this surface.

// Kernel — state holders + dispatch.
export * from "../../src/kernel/editor"
export * from "../../src/kernel/buffer"
export * from "../../src/kernel/keymap"
export * from "../../src/kernel/command"
export * from "../../src/kernel/window"
export * from "../../src/kernel/hooks"
export * from "../../src/kernel/backup-path"
export * from "../../src/kernel/completion"
export * from "../../src/kernel/events"
export * from "../../src/kernel/extension-points"
export * from "../../src/kernel/isearch"
export * from "../../src/kernel/prefix-argument"
export * from "../../src/kernel/register"
export * from "../../src/kernel/transient-mark"

// Runtime — eval/plugin surface (defcustom, defineMode, addHook, addAdvice, …)
// plus the per-plugin disposable registration context.
export * from "../../src/runtime/jemacs-runtime"
export * from "../../src/runtime/plugin-context"
export * from "../../src/runtime/advice"
export * from "../../src/runtime/custom"
export * from "../../src/runtime/definitions"
export * from "../../src/runtime/evaluator"
export * from "../../src/runtime/faces"
export * from "../../src/runtime/generic"
export * from "../../src/runtime/inspect"
export * from "../../src/runtime/interactive"
export * from "../../src/runtime/key-registry"
export * from "../../src/runtime/live-source"
export * from "../../src/runtime/load-path"
export * from "../../src/runtime/patch-eval"
export * from "../../src/runtime/source"

// Display — host-agnostic model + UiHost protocol + theme primitives.
export * from "../../src/display/protocol"
export * from "../../src/display/theme"
// Disambiguate: kernel/extension-points also declares FaceStyle/Theme; the
// display/theme versions are the canonical public types.
export type { FaceStyle, Theme } from "../../src/display/theme"
