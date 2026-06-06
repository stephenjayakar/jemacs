import { dirname, resolve } from "node:path"
import { homedir } from "node:os"
import { appendFile, mkdir } from "node:fs/promises"
import type { Editor } from "../src/kernel/editor"
import type { BufferModel } from "../src/kernel/buffer"
import { Keymap, keyToken, type KeyEventLike } from "../src/kernel/keymap"
import { defaultTheme, disableBuiltinTheme, enableBuiltinTheme, getBuiltinTheme, isBuiltinThemeEnabled, listEnabledBuiltinThemes, themeSource } from "../src/themes"
import { defcustom, getCustom } from "../src/runtime/custom"
import { saveContextOptions } from "../src/core/save-context"
import { Evaluator } from "../src/runtime/evaluator"
import { createPluginContext, type PluginContext } from "../src/runtime/plugin-context"
import { revertAllDefinitions } from "../src/runtime/patch-eval"
import { inspectValue } from "../src/runtime/inspect"
import { defineMinorMode } from "../src/modes/minor-mode"

defcustom("text-scale-mode-step", "number", 1.2,
  "Each step of text scale multiplies face height by this factor.")

const TEXT_SCALE_AMOUNT_KEY = "text-scale-mode-amount"
const TEXT_SCALE_ADJUST_MAP = "text-scale-adjust-map"
const MIN_AMOUNT = -20
const MAX_AMOUNT = 20

type TextScaleAdjustState = { repeatInc: number; map: Keymap | null }
const textScaleAdjust = new WeakMap<Editor, TextScaleAdjustState>()
function textScaleAdjustState(editor: Editor): TextScaleAdjustState {
  let s = textScaleAdjust.get(editor)
  if (!s) textScaleAdjust.set(editor, s = { repeatInc: 1, map: null })
  return s
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor), evaluator: Evaluator = new Evaluator(editor)): Evaluator {
  void ctx // commands/keys overwrite in place; ctx reserved for future hooks/advice here

  // ---- prefix args / quit ------------------------------------------------

  editor.command("keyboard-quit", ({ editor }) => {
    editor.keymaps.clearPending()
    editor.prefixArg.clear()
    clearTextScaleAdjustMap(editor)
    if (editor.isearch) editor.cancelIsearch()
    if (editor.minibuffer) editor.minibufferCancel()
    editor.currentBuffer.clearMark()
    editor.message("Quit")
  }, "Cancel the active key sequence, minibuffer, isearch, or mark.")

  editor.command("universal-argument", ({ editor }) => {
    const value = editor.prefixArg.universalArgument()
    editor.message(`C-u ${editor.prefixArg.isNegative() ? "-" : ""}${value}`)
  }, "Begin or multiply the numeric prefix argument.")

  editor.command("negative-argument", ({ editor }) => {
    editor.prefixArg.toggleNegative()
    editor.message(`Negative argument ${editor.prefixArg.describe()}`)
  }, "Set or invert the sign of the numeric prefix argument.")

  editor.command("digit-argument", ({ editor, args }) => {
    const digit = Number(args[0])
    if (!Number.isFinite(digit)) return
    const value = editor.prefixArg.addDigit(digit)
    const sign = editor.prefixArg.isNegative() ? "-" : ""
    editor.message(`Argument ${sign}${value}`)
  }, "Add a digit to the numeric prefix argument.")

  // ---- registers ---------------------------------------------------------

  editor.command("point-to-register", async ({ buffer, editor, args }) => {
    const register = args[0] ?? await editor.prompt("Point to register: ", "f", "register")
    if (!register) return
    editor.registers.set(register, { kind: "point", point: buffer.point, bufferId: buffer.id })
    editor.message(`Saved point ${buffer.point} to register ${register}`)
  }, "Save point to a register.")

  editor.command("jump-to-register", async ({ editor, args }) => {
    const register = args[0] ?? await editor.prompt("Jump to register: ", "f", "register")
    if (!register) return
    const value = editor.registers.get(register)
    if (!value) { editor.message(`Register ${register} is empty`); return }
    if (value.kind === "point") {
      if (value.bufferId && editor.buffers.has(value.bufferId)) editor.switchToBuffer(value.bufferId)
      const buffer = editor.currentBuffer
      buffer.point = Math.max(0, Math.min(value.point, buffer.text.length))
      editor.setSelectedWindowPoint(buffer.point)
      return
    }
    if (value.kind === "window-configuration") { editor.restoreWindowConfiguration(value); return }
    editor.message(`Register ${register} does not contain a location`)
  }, "Jump to a saved point or window configuration register.")

  // ---- help --------------------------------------------------------------

  editor.command("describe-key-briefly", async ({ editor, args }) => {
    const sequence = args.join(" ") || await editor.prompt("Describe key briefly: ", "", "describe-key-briefly")
    if (!sequence) return
    editor.message(editor.describeKey(sequence))
  }, "Type a key sequence; print its full command name in the echo area.")

  editor.command("describe-bindings", ({ editor }) => {
    const lines = editor.keymap.all().map(([k, v]) => `${k.padEnd(16)} ${v}`)
    editor.scratch("*Help*", lines.join("\n"), "text")
  }, "Describe key bindings of the current keymap.")

  editor.command("view-echo-area-messages", ({ editor }) => {
    editor.switchToBuffer("*messages*")
  }, "Display the messages buffer.")

  editor.command("apropos-command", async ({ editor, args }) => {
    const pattern = args[0] ?? await editor.prompt("Apropos: ", "", "apropos")
    if (!pattern) return
    let re: RegExp
    try {
      re = new RegExp(pattern, "i")
    } catch (err) {
      editor.message(`Invalid regexp: ${(err as SyntaxError).message}`)
      return
    }
    const lines = editor.commands.entries()
      .filter(c => re.test(c.name) || re.test(c.description ?? ""))
      .map(c => `${c.name.padEnd(24)} ${c.description ?? ""}`)
    editor.scratch("*Help*", lines.join("\n") || "No matches", "text")
  }, "Show commands matching a pattern.")

  editor.command("help-command", ({ editor }) => {
    editor.message("Help (C-h …): b bindings, c mode, k key, f function, v variable, a apropos, e messages")
  }, "Display help key prefix summary.")

  editor.command("help-for-help", ({ editor }) => {
    const lines = [
      "C-h b    describe-bindings",
      "C-h c    describe-mode",
      "C-h m    describe-mode",
      "C-h k    describe-key",
      "C-h f    describe-function (RET follows source)",
      "C-h v    describe-variable (custom; RET → source)",
      "C-h a    apropos-command",
      "C-h e    view-echo-area-messages",
      "C-h C-h  help-for-help",
    ]
    editor.scratch("*Help*", lines.join("\n"), "text")
  }, "Describe help commands.")

  editor.command("count-lines-page", ({ buffer, editor }) => {
    const lines = buffer.text.split("\n").length
    editor.message(`${lines} lines in buffer`)
  }, "Count lines in the current page.")

  // ---- eval / load -------------------------------------------------------

  editor.command("eval-region", async ({ buffer, editor }) => {
    const code = buffer.selectedOrAll()
    try {
      const result = await evaluator.eval(code, buffer.path ?? buffer.name)
      editor.message(`Eval => ${summarize(result)}`)
      return result
    } catch (err) {
      const e = err as Error
      editor.scratch("*Backtrace*", e.stack ?? String(e), "text")
      editor.message(`Eval error: ${e.message}`)
    }
  }, "Evaluate the selection, or the whole buffer if no selection is active.")

  editor.command("eval-expression", async ({ editor, args }) => {
    const expression = args.join(" ") || await editor.prompt("Eval expression: ", "", "eval-expression")
    if (!expression) return
    try {
      const result = await evaluator.evalExpression(expression)
      editor.scratch("*eval-result*", inspectValue(result), "text")
    } catch (err) {
      const e = err as Error
      editor.scratch("*Backtrace*", e.stack ?? String(e), "text")
      editor.message(`Eval error: ${e.message}`)
    }
  }, "Evaluate a JavaScript expression and display its result.")

  editor.command("load-plugin", async ({ editor, args }) => {
    const path = args[0] ?? await editor.completingRead("Load plugin: ", { completion: "file", history: "file", initialValue: "plugins/demo-plugin.ts" })
    if (!path) return
    try {
      await evaluator.loadPlugin(path)
      editor.message(`Loaded plugin ${path}`)
    } catch (err) {
      const e = err as Error
      editor.scratch("*Backtrace*", e.stack ?? String(e), "text")
      editor.message(`Load error: ${e.message}`)
    }
  }, "Load a plugin module exporting install(editor).")

  editor.command("reload-current-file", async ({ buffer, editor }) => {
    if (!buffer.path) {
      editor.message("Current buffer is not visiting a file")
      return
    }
    revertAllDefinitions(editor)
    if (buffer.dirty) {
      try {
        await buffer.save({
          confirm: async (p: string) => (await readKey(editor, `${p} (y or n) `)) === "y",
          ...saveContextOptions(),
        })
      } catch (err) { editor.message((err as Error).message); return }
    }
    const display = editor.bufferDisplayName(buffer)
    const mod = await evaluator.loadModule(buffer.path)
    if (typeof mod.install === "function") {
      await evaluator.loadPlugin(buffer.path)
      editor.message(`Reloaded ${display} via install(editor, ctx)`)
      return
    }
    if (typeof mod.installDefaultConfig === "function") {
      mod.installDefaultConfig(editor)
      editor.message(`Reloaded ${display} via installDefaultConfig(editor)`)
      return
    }
    if (typeof mod.installDefaultCommands === "function") {
      mod.installDefaultCommands(editor)
      editor.message(`Reloaded ${display} via installDefaultCommands(editor)`)
      return
    }
    editor.message(`Reloaded ${display}; no installer export found`)
  }, "Save and reload the current TypeScript/JavaScript file into the live editor.")

  editor.command("i-bind-key", async ({ editor, args }) => {
    const sequence = args[0] ?? await editor.prompt("Key sequence to bind: ", "", "keybind")
    if (!sequence) return
    const command = args[1] ?? await editor.completingRead(`Command to bind to ${sequence}: `, { collection: editor.commands.names(), history: "command" })
    if (!command) return
    if (!editor.commands.get(command)) throw new Error(`Not an interactive command: ${command}`)
    editor.key(sequence, command)
    const file = resolve(process.env.JEMACS_KEYBINDS_FILE ?? `${homedir()}/.jemacs/keybinds.js`)
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, `// Added on ${new Date().toISOString()}\neditor.key(${JSON.stringify(sequence)}, ${JSON.stringify(command)})\n`)
    editor.message(`Bound ${sequence} to ${command} and saved it to ${file}`)
  }, "Interactively bind a key and persist it to the Jemacs keybinds file.")

  // ---- keyboard macros ---------------------------------------------------

  editor.command("start-kbd-macro", ({ editor }) => {
    editor.macroRecording = []
    editor.message("Starting keyboard macro")
  }, "Start recording a keyboard macro.")

  editor.command("end-kbd-macro", ({ editor }) => {
    if (!editor.macroRecording) {
      editor.message("No macro definition in progress")
      return
    }
    editor.lastKbdMacro = editor.macroRecording
    editor.macroRecording = null
    editor.message(`Keyboard macro defined (${editor.lastKbdMacro.length} events)`)
  }, "Finish defining a keyboard macro.")

  editor.command("call-last-kbd-macro", async ({ editor }) => {
    if (!editor.lastKbdMacro.length) {
      editor.message("No keyboard macro defined")
      return
    }
    for (const command of editor.lastKbdMacro) await editor.run(command)
    editor.message("Executed keyboard macro")
  }, "Call the last keyboard macro.")

  // ---- themes ------------------------------------------------------------

  editor.command("load-theme", ({ editor, args }) => {
    const name = args[0]?.trim()
    if (name) {
      const theme = enableBuiltinTheme(name)
      if (!theme) {
        editor.message(`Unknown theme: ${name}`)
        return
      }
      editor.setTheme(theme)
    } else {
      editor.setTheme(editor.theme)
    }
    editor.message(`Loaded theme ${editor.theme.name}`)
  }, "Load a built-in theme by name, or reload the active theme.")

  editor.command("enable-theme", async ({ editor, args }) => {
    const name = args[0]?.trim() || themeNameAtPoint(editor)
    if (!name) {
      editor.message("No theme specified")
      return
    }
    if (!args[0] && isBuiltinThemeEnabled(name)) {
      disableBuiltinTheme(name)
      const active = listEnabledBuiltinThemes().at(-1)
      editor.setTheme(active ? getBuiltinTheme(active)! : defaultTheme)
      await refreshThemeBufferIfCurrent(editor)
      editor.message(`Disabled theme ${name}`)
      return
    }
    const theme = enableBuiltinTheme(name)
    if (!theme) {
      editor.message(`Unknown theme: ${name}`)
      return
    }
    editor.setTheme(theme)
    await refreshThemeBufferIfCurrent(editor)
    editor.message(`Enabled theme ${name}`)
  }, "Enable a built-in theme.")

  editor.command("disable-theme", async ({ editor, args }) => {
    const name = args[0]?.trim() || themeNameAtPoint(editor)
    if (!name) {
      editor.message("No theme specified")
      return
    }
    if (!getBuiltinTheme(name)) {
      editor.message(`Unknown theme: ${name}`)
      return
    }
    disableBuiltinTheme(name)
    const enabled = listEnabledBuiltinThemes()
    const active = enabled.at(-1)
    editor.setTheme(active ? getBuiltinTheme(active)! : defaultTheme)
    await refreshThemeBufferIfCurrent(editor)
    editor.message(`Disabled theme ${name}`)
  }, "Disable a built-in theme.")

  editor.command("describe-theme", ({ editor, args }) => {
    const name = args[0]?.trim() || themeNameAtPoint(editor)
    if (!name) {
      editor.message("No theme specified")
      return
    }
    const theme = getBuiltinTheme(name)
    if (!theme) {
      editor.message(`Unknown theme: ${name}`)
      return
    }
    editor.scratch("*Help*", [
      `${name} theme`,
      "",
      `${themeSource(name)} Custom theme.`,
      "",
      `Faces: ${Object.keys(theme.faces).sort().join(", ")}`,
    ].join("\n"), "help")
  }, "Describe a Custom theme.")

  // ---- text scale --------------------------------------------------------

  editor.command("text-scale-set", ({ editor, buffer, args, prefixArgument }) => {
    const level = prefixArgument ?? Number(args[0])
    if (!Number.isFinite(level)) return
    textScaleSet(editor, buffer, level)
  }, "Set buffer text scale to LEVEL steps (0 = default).")

  editor.command("text-scale-increase", ({ editor, buffer, args, prefixArgument }) => {
    const inc = prefixArgument ?? Number(args[0])
    if (!Number.isFinite(inc)) return
    textScaleIncrease(editor, buffer, inc)
  }, "Increase buffer text scale by INC steps (0 resets).")

  editor.command("text-scale-decrease", ({ editor, buffer, args, prefixArgument }) => {
    const dec = prefixArgument ?? Number(args[0])
    if (!Number.isFinite(dec)) return
    textScaleIncrease(editor, buffer, -dec)
  }, "Decrease buffer text scale by DEC steps.")

  editor.command("text-scale-adjust", ({ editor, buffer, args, prefixArgument, keyEvent }) => {
    const state = textScaleAdjustState(editor)
    const inc = Math.abs(prefixArgument ?? (Number(args[0]) || state.repeatInc)) || 1
    if (prefixArgument != null || args[0]) state.repeatInc = inc
    const step = textScaleStepFromKey(keyEvent, inc)
    textScaleIncrease(editor, buffer, step)
    if (step !== 0) {
      installTextScaleAdjustMap(editor, inc)
      editor.message("Use +, =, -, or 0 for further adjustment")
    } else {
      clearTextScaleAdjustMap(editor)
    }
  }, "Adjust buffer text scale; repeats with +, =, -, or 0.")

  // ---- key bindings ------------------------------------------------------

  editor.key("C-g", "keyboard-quit")
  editor.key("C-u", "universal-argument")
  editor.key("M--", "negative-argument")
  editor.key("C-c d", "point-to-register")
  editor.key("C-c C-d", "jump-to-register")
  editor.key("C-x r SPC", "point-to-register")
  editor.key("C-x r j", "jump-to-register")
  editor.key("C-h b", "describe-bindings")
  editor.key("C-h e", "view-echo-area-messages")
  editor.key("C-h a", "apropos-command")
  editor.key("C-h C-h", "help-for-help")
  editor.key("C-x l", "count-lines-page")
  editor.key("C-x C-e", "eval-region")
  editor.key("C-c C-l", "load-plugin")
  editor.key("C-c C-r", "reload-current-file")
  editor.key("C-x (", "start-kbd-macro")
  editor.key("C-x )", "end-kbd-macro")
  editor.key("C-x e", "call-last-kbd-macro")
  for (const key of ["C-x C-+", "C-x C-=", "C-x C--", "C-x C-0"]) {
    editor.key(key, "text-scale-adjust")
  }

  editor.defineKey("minibuffer", "C-u", "universal-argument")
  editor.defineKey("minibuffer", "M--", "negative-argument")
  editor.defineKey("minibuffer", "C-g", "keyboard-quit")

  return evaluator
}

// ---- helpers -------------------------------------------------------------

/** Read one keystroke as an Emacs key token (e.g. "y", "C-g", "RET") without
 *  opening a minibuffer. Resolves to `null` on C-g. */
export function readKey(editor: Editor, prompt: string): Promise<string | null> {
  editor.message(prompt)
  return new Promise(resolveKey => {
    const original = editor.handleKey
    editor.handleKey = async key => {
      editor.handleKey = original
      const token = keyToken(key)
      resolveKey(token === "C-g" ? null : token)
      return { status: "command", command: "read-key" }
    }
  })
}

function summarize(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.slice(0, 80))
  if (typeof value === "undefined") return "undefined"
  if (value === null) return "null"
  if (typeof value === "object") return value.constructor?.name ?? "object"
  return String(value)
}

function themeNameAtPoint(editor: Editor): string | null {
  if (!editor.currentBuffer.locals.get("jemacs-customize-theme")) return null
  const line = editor.currentBuffer.lineBoundsAt().text
  const direct = /^Theme:\s+(.+?)\s+\[/.exec(line)?.[1]
  if (direct && getBuiltinTheme(direct.trim())) return direct.trim()
  const before = editor.currentBuffer.text.slice(0, editor.currentBuffer.point)
  const matches = [...before.matchAll(/^Theme:\s+(.+?)\s+\[/gm)]
  const name = matches.at(-1)?.[1]?.trim()
  return name && getBuiltinTheme(name) ? name : null
}

async function refreshThemeBufferIfCurrent(editor: Editor): Promise<void> {
  if (!editor.currentBuffer.locals.get("jemacs-customize-theme")) return
  await editor.run("customize-themes")
}

export function getTextScaleAmount(buffer: BufferModel): number {
  return (buffer.locals.get(TEXT_SCALE_AMOUNT_KEY) as number | undefined) ?? 0
}

export function textScaleFactor(buffer: BufferModel): number {
  const amount = getTextScaleAmount(buffer)
  if (amount === 0) return 1
  const step = getCustom<number>("text-scale-mode-step") ?? 1.2
  return step ** amount
}

export function textScaleLighter(buffer: BufferModel): string {
  const amount = getTextScaleAmount(buffer)
  if (amount === 0) return ""
  return amount >= 0 ? ` +${amount}` : ` ${amount}`
}

export function installTextScaleMode(): void {
  defineMinorMode({ name: "text-scale-mode" })
}

function setTextScaleAmount(buffer: BufferModel, amount: number): void {
  if (amount === 0) buffer.locals.delete(TEXT_SCALE_AMOUNT_KEY)
  else buffer.locals.set(TEXT_SCALE_AMOUNT_KEY, amount)
}

function syncTextScaleMode(editor: Editor, buffer: BufferModel, amount: number): void {
  if (amount === 0) editor.disableMinorMode("text-scale-mode", { buffer })
  else editor.enableMinorMode("text-scale-mode", { buffer })
}

function textScaleSet(editor: Editor, buffer: BufferModel, level: number): void {
  const clamped = Math.max(MIN_AMOUNT, Math.min(MAX_AMOUNT, level))
  setTextScaleAmount(buffer, clamped)
  syncTextScaleMode(editor, buffer, clamped)
  void editor.changed("text-scale")
}

function textScaleIncrease(editor: Editor, buffer: BufferModel, inc: number): void {
  const current = getTextScaleAmount(buffer)
  const newValue = inc === 0 ? 0 : current + inc
  if (newValue > MAX_AMOUNT || newValue < MIN_AMOUNT) {
    editor.message(`Cannot ${inc > 0 ? "increase" : "decrease"} the font size any further`)
    return
  }
  textScaleSet(editor, buffer, newValue)
}

function eventBasicType(key: KeyEventLike | null): string | null {
  if (!key) return null
  if (key.sequence?.length === 1) return key.sequence
  const base = keyToken(key).split("-").pop() ?? ""
  if (base.length === 1) return base
  if (base === "plus" || base === "equal") return "="
  if (base === "minus" || base === "hyphen") return "-"
  return base
}

function textScaleStepFromKey(key: KeyEventLike | null, inc: number): number {
  const base = eventBasicType(key)
  if (base === "+" || base === "=") return inc
  if (base === "-") return -inc
  if (base === "0") return 0
  return inc
}

function installTextScaleAdjustMap(editor: Editor, inc: number): void {
  const state = textScaleAdjustState(editor)
  state.repeatInc = Math.abs(inc) || 1
  const map = new Keymap(TEXT_SCALE_ADJUST_MAP)
  for (const mods of ["", "C-"]) {
    for (const key of ["+", "=", "-", "0"]) {
      map.bind(`${mods}${key}`, "text-scale-adjust")
    }
  }
  state.map = map
  editor.overridingMap = map
}

function clearTextScaleAdjustMap(editor: Editor): void {
  const state = textScaleAdjustState(editor)
  if (state.map && editor.overridingMap === state.map) {
    editor.overridingMap = null
  }
  state.map = null
}
