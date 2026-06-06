import { expect } from "bun:test"
import { Editor } from "../../src/kernel/editor"
import { BufferModel } from "../../src/kernel/buffer"
import { type KeyEventLike } from "../../src/kernel/keymap"
import { installDefaultModes } from "../../src/modes/default-modes"
import { installDefaultConfig } from "../../src/config"
import { installBuiltinPlugins } from "../../plugins/builtin"
import { resetTestGlobals } from "../plugins/helper"

/** Parse an Emacs-style key token into the KeyEventLike a terminal would send.
 *  This is the *inverse* of `keyToken()` — tests written with string tokens
 *  exercise the real handleKey→keyToken→keymap path, not editor.run(). */
export function parseKey(token: string): KeyEventLike {
  if (token.length === 1) return { name: token, sequence: token }
  const aliases: Record<string, string> = {
    Enter: "return", RET: "return", SPC: "space", Space: "space",
    TAB: "tab", Tab: "tab", DEL: "backspace", BSpace: "backspace",
    ESC: "escape", Escape: "escape",
  }
  if (aliases[token]) return { name: aliases[token] }
  const m = /^((?:[CMSs]-)+)(.+)$/.exec(token)
  if (!m) return { name: token.toLowerCase() }
  const mods = m[1]
  const name = aliases[m[2]] ?? (m[2].length === 1 ? m[2] : m[2].toLowerCase())
  return {
    name,
    sequence: m[2].length === 1 ? m[2] : undefined,
    ctrl: mods.includes("C-") || undefined,
    meta: mods.includes("M-") || undefined,
    shift: mods.includes("S-") || undefined,
  }
}

/** Feed key tokens or raw events through the real `handleKey` path. */
export async function keySeq(editor: Editor, ...keys: Array<string | KeyEventLike>): Promise<void> {
  for (const k of keys) {
    await editor.handleKey(typeof k === "string" ? parseKey(k) : k)
  }
}

export type ScriptExpect = {
  text(expected: string): EditorScript
  point(expected: number): EditorScript
  mark(expected: number | null): EditorScript
  line(expected: number): EditorScript
  col(expected: number): EditorScript
  message(substring: string): EditorScript
  bufferName(expected: string): EditorScript
  that(fn: (editor: Editor, buffer: BufferModel) => void): EditorScript
}

export type EditorScript = {
  /** Replace current buffer text and put point at end. */
  text(s: string): EditorScript
  point(n: number): EditorScript
  mark(n: number, active?: boolean): EditorScript
  mode(name: string): EditorScript
  keys(...tokens: Array<string | KeyEventLike>): EditorScript
  run(command: string, ...args: unknown[]): EditorScript
  do(fn: (editor: Editor, buffer: BufferModel) => void | Promise<void>): EditorScript
  expect: ScriptExpect
  /** Resolve all queued steps and return the editor for further inspection. */
  done(): Promise<Editor>
  editor: Editor
}

export function script(opts?: { plugins?: boolean }): EditorScript {
  resetTestGlobals()
  installDefaultModes()
  const editor = new Editor()
  installDefaultConfig(editor)
  let chain: Promise<void> = opts?.plugins === false
    ? Promise.resolve()
    : installBuiltinPlugins(editor)
  let lastMessage = ""
  editor.events.on("message", ({ text }) => { lastMessage = text })

  const buf = () => editor.currentBuffer
  const step = (fn: () => void | Promise<void>): EditorScript => {
    chain = chain.then(fn)
    return self
  }

  const expectApi: ScriptExpect = {
    text: s => step(() => expect(buf().text).toBe(s)),
    point: n => step(() => expect(buf().point).toBe(n)),
    mark: n => step(() => expect(buf().mark).toBe(n)),
    line: n => step(() => expect(buf().lineCol().line).toBe(n)),
    col: n => step(() => expect(buf().lineCol().col).toBe(n)),
    message: s => step(() => expect(lastMessage).toContain(s)),
    bufferName: s => step(() => expect(buf().name).toBe(s)),
    that: fn => step(() => fn(editor, buf())),
  }

  const self: EditorScript = {
    text: s => step(() => { buf().setText(s); buf().point = s.length }),
    point: n => step(() => { buf().point = n }),
    mark: (n, active = true) => step(() => { buf().mark = n; buf().markActive = active }),
    mode: name => step(() => { buf().mode = name }),
    keys: (...ks) => step(() => keySeq(editor, ...ks)),
    run: (cmd, ...args) => step(() => editor.run(cmd, args.length ? args : undefined)),
    do: fn => step(() => fn(editor, buf())),
    expect: expectApi,
    done: async () => { await chain; return editor },
    get editor() { return editor },
  }
  return self
}
