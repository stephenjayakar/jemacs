import { defineMode } from "./mode"

export function installMinibufferMode(): void {
  defineMode({ name: "minibuffer", parent: "text" })
}
