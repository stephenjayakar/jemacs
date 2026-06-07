import { TuiTermRawMap } from "./keymap"

/** Shared singleton char-mode keymap. The class is small, but each
 *  TuiTermRawMap instance has its own `bindings` map; tests assert against
 *  the singleton, so the plugin reuses this one. */
export const termRawMap = new TuiTermRawMap()
export { TuiTermRawMap }
