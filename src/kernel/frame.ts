import type { WindowConfiguration } from "./register"
import { createLeafWindow, type WindowId, type WindowNode } from "./window"

/**
 * One tab-bar tab: a named window configuration, exactly as tab-bar.el stores it.
 *
 * The selected tab has no `config`, because its layout is the frame's live one;
 * `Editor.captureSelectedTab` writes the config back the moment the tab is left.
 * `bufferId` tracks the buffer of the tab's selected window, which is what the
 * automatic tab name comes from (Emacs `tab-bar-tab-name-current`).
 */
export type TabRecord = {
  /** Name set by `tab-bar-rename-tab`; ignored while `explicitName` is false. */
  name: string
  /** Emacs `explicit-name`: true after `tab-bar-rename-tab` with a non-empty name. */
  explicitName: boolean
  /**
   * Emacs `time`: when the tab was last selected, and the sole input to the
   * `recent` ordering. A counter rather than a clock, because Emacs stores
   * `float-time` at microsecond resolution while `Date.now()` is milliseconds:
   * two tabs selected inside one millisecond would tie and order arbitrarily.
   */
  time: number
  bufferId: string
  /** Saved layout. Absent on the selected tab, whose layout is the live one. */
  config?: WindowConfiguration
}

/**
 * An Emacs frame: an independent window tree with its own selected window.
 *
 * Buffers, the kill ring, registers and every other editor-level structure stay
 * on `Editor`, so all frames share them exactly as GNU Emacs does. A frame owns
 * only what is genuinely per-display: the window layout, which window is
 * selected within it, and its tab-bar tabs. `Editor.windowLayout` /
 * `Editor.selectedWindowId` delegate to the selected frame, so code that
 * predates frames keeps working and automatically acts on the focused frame.
 */
export type FrameRecord = {
  id: string
  /** Display name, shown in the frame's title bar (GUI) and `list-frames`. */
  name: string
  layout: WindowNode
  selectedWindowId: WindowId
  /** Tab-bar tabs. Never empty: a frame always has one current tab. */
  tabs: TabRecord[]
  selectedTab: number
}

export function createFrame(bufferId: string, name: string, point = 0): FrameRecord {
  const root = createLeafWindow(bufferId, point)
  return {
    id: crypto.randomUUID(),
    name,
    layout: root,
    selectedWindowId: root.id,
    tabs: [makeTab(bufferId)],
    selectedTab: 0,
  }
}

let tabClock = 0

/** Monotonic stamp for `TabRecord.time`. */
export function tabTimestamp(): number {
  return ++tabClock
}

export function makeTab(bufferId: string, name = "", explicitName = false): TabRecord {
  return { name, explicitName, time: tabTimestamp(), bufferId }
}
