import type { WindowNode } from "./window"

export type RegisterContents =
  | { kind: "point"; point: number; bufferId?: string }
  | { kind: "window-configuration"; layout: WindowNode; selectedWindowId: string; currentBufferId: string }
  | { kind: "text"; text: string }
  | { kind: "rectangle"; lines: string[] }
