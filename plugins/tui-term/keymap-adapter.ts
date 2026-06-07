import { JTermRawMap } from "./keymap"

/** Shared singleton char-mode keymap. The class is small, but each
 *  JTermRawMap instance has its own `bindings` map; tests assert against
 *  the singleton, so the plugin reuses this one. */
export const jtermRawMap = new JTermRawMap()
export { JTermRawMap }
