/**
 * The tab bar's display string (Emacs `tab-bar-format`).
 *
 * Only the drawing lives here; the commands and the `defcustom`s live in
 * `lisp/tab-bar.ts`. The split is the usual one: `src/display` may not import
 * `lisp/`, but it can read the customs by name through `getCustom`.
 */
import type { Editor } from "../kernel/editor"
import type { FrameRecord } from "../kernel/frame"
import type { TextSpan } from "../modes/mode"
import { getCustom } from "../runtime/custom"

export const TAB_BAR_MODE = "tab-bar-mode"

export function tabBarModeEnabled(editor: Editor): boolean {
  return editor.globalMinorModes.has(TAB_BAR_MODE)
}

/**
 * Is the bar drawn for this frame?
 *
 * `tab-bar-show` t always draws it, a number draws it only once the tab count
 * exceeds that number (so 1 hides a lone tab), and nil never draws it.
 */
export function tabBarVisible(editor: Editor, frame: FrameRecord = editor.selectedFrame): boolean {
  if (!tabBarModeEnabled(editor)) return false
  const show = getCustom<boolean | number>("tab-bar-show")
  if (show === true) return true
  if (typeof show === "number") return frame.tabs.length > show
  return false
}

/** Rows the tab bar steals from the window stack: one line, or none. */
export function tabBarLines(editor: Editor, frame?: FrameRecord): number {
  return tabBarVisible(editor, frame) ? 1 : 0
}

/** Which segment of the bar a column belongs to, for click routing. */
export type TabBarHit =
  | { kind: "select"; index: number }
  | { kind: "close"; index: number }
  | { kind: "new" }

export type TabBarLayout = {
  text: string
  spans: TextSpan[]
  /** `hits[col]` is the element under that column, or null for a separator. */
  hits: Array<TabBarHit | null>
}

/**
 * Emacs `tab-bar-format`, flattened to text plus faces.
 *
 * The default format is `tab-bar-format-tabs`, `tab-bar-separator`,
 * `tab-bar-format-add-tab`, and each tab is `SEP NAME [CLOSE]`. A two-tab bar
 * therefore reads `|a x|bbb x| + `, which is exactly what `emacs -Q` prints.
 */
export function tabBarLayout(editor: Editor, frame: FrameRecord = editor.selectedFrame): TabBarLayout {
  const separator = getCustom<string>("tab-bar-separator") ?? "|"
  const closeButton = getCustom<string>("tab-bar-close-button") ?? " x"
  const newButton = getCustom<string>("tab-bar-new-button") ?? " + "
  const closeShow = getCustom<boolean | string>("tab-bar-close-button-show")
  const hints = getCustom<boolean>("tab-bar-tab-hints") === true

  let text = ""
  const spans: TextSpan[] = []
  const hits: Array<TabBarHit | null> = []
  const push = (chunk: string, hit: TabBarHit | null) => {
    text += chunk
    for (let i = 0; i < chunk.length; i++) hits.push(hit)
  }

  frame.tabs.forEach((tab, index) => {
    const isSelected = index === frame.selectedTab
    push(separator, null)
    const start = text.length
    push(`${hints ? `${index + 1} ` : ""}${editor.tabName(tab)}`, { kind: "select", index })
    // `tab-bar-tab-name-format-close-button`: `selected` / `non-selected` name
    // the tabs that must *not* carry the button.
    const showClose = closeShow === true
      || (closeShow === "selected" && isSelected)
      || (closeShow === "non-selected" && !isSelected)
    if (showClose) push(closeButton, { kind: "close", index })
    spans.push({ start, end: text.length, face: isSelected ? "tab-bar-tab" : "tab-bar-tab-inactive" })
  })

  push(separator, null)
  if (getCustom<boolean>("tab-bar-new-button-show") !== false) push(newButton, { kind: "new" })
  // Emacs draws the whole row on the `tab-bar' face and layers the per-tab
  // faces over it, so separators and the "+" button share the bar's
  // background. `applyTheme` merges a fully-covering span underneath.
  return { text, spans: [{ start: 0, end: text.length, face: "tab-bar" }, ...spans], hits }
}

/** Which tab-bar element sits at column `col`? */
export function tabBarHitTest(editor: Editor, col: number, frame?: FrameRecord): TabBarHit | null {
  return tabBarLayout(editor, frame).hits[col] ?? null
}
