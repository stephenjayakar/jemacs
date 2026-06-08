import { createRequire } from "node:module"
import type { IBuffer, IBufferCell, ITerminalOptions, Terminal } from "@xterm/headless"

export type { IBuffer, IBufferCell, Terminal }

type TerminalCtor = new (options: ITerminalOptions) => Terminal

const require = createRequire(import.meta.url)

/** Bun exposes named `Terminal`; Node/Electron only default-export the class. */
function resolveTerminalCtor(mod: unknown): TerminalCtor {
  const m = mod as { Terminal?: TerminalCtor; default?: TerminalCtor }
  const ctor = m.Terminal ?? m.default
  if (!ctor) throw new Error("@xterm/headless: no Terminal export")
  return ctor
}

let cached: TerminalCtor | undefined

function terminalCtor(): TerminalCtor {
  if (!cached) cached = resolveTerminalCtor(require("@xterm/headless"))
  return cached
}

export function makeXTerm(rows: number, cols: number): Terminal {
  const TerminalClass = terminalCtor()
  return new TerminalClass({ rows, cols, allowProposedApi: true, scrollback: 10_000 })
}
