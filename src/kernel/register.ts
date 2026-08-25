import type { WindowNode } from "./window"

export type RegisterContents =
  | { kind: "point"; point: number; bufferId?: string }
  | { kind: "window-configuration"; layout: WindowNode; selectedWindowId: string; currentBufferId: string }
  | { kind: "text"; text: string }
  | { kind: "number"; value: number }
  | { kind: "rectangle"; lines: string[] }

/** The saved window layout a register (or a tab-bar tab) restores. */
export type WindowConfiguration = Extract<RegisterContents, { kind: "window-configuration" }>
