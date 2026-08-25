import type { Editor } from "../kernel/editor"
import { normalizeSequence } from "../kernel/keymap"
import type { CustomVariable } from "./custom"
import { getCustomVariable, listCustomVariables } from "./custom"
import type { Evaluator } from "./evaluator"
import {
  getCatalogEntry,
  listCatalogEntries,
  type DefinitionKind,
  type DefinitionRef,
} from "./definitions"
import { getKeyBinding, listKeyBindings } from "./key-registry"
import { evalDefinitionForm, revertAllDefinitions, revertDefinition } from "./patch-eval"
import {
  extractTopLevelForm,
  formatDescribeFunction,
  formatSourceLine,
  parseSourceLineAtPoint,
  visitSource,
} from "./source"
import { getMode } from "../modes/mode"
import { HELP_BUTTONS_KEY, helpButtonAt, moveHelpButton, type HelpButton } from "../modes/help"

export const HELP_TOPIC_KEY = "jemacs-help-topic"
export const HELP_HISTORY_KEY = "jemacs-help-history"

export type HelpTopic =
  | { kind: "command"; name: string }
  | { kind: "variable"; name: string }
  | { kind: "key"; map: string; sequence: string }
  | { kind: "mode"; name: string }
  | { kind: "definition"; ref: DefinitionRef }

export type HelpPage = {
  command: string
  args: string[]
}

type HelpHistory = {
  entries: HelpPage[]
  index: number
  navigating?: boolean
}

export function installLiveSourceCommands(editor: Editor, evaluator: Evaluator): void {
  editor.command("find-function", async ({ editor, args }) => {
    const ref = helpTopicRef(editor)
    const name = args[0] ?? ref?.name ?? await editor.completingRead("Find function: ", { collection: editor.commands.names(), history: "command" })
    if (!name) return
    await visitDefinitionSource(editor, { kind: "command", name })
    editor.message(`Found definition of ${name}`)
  }, "Visit the source of a command or other definition.")

  editor.command("jemacs-find-definition", async ({ editor, args }) => {
    const label = args[0] ?? await pickDefinition(editor)
    if (!label) return
    const ref = parseDefinitionLabel(label)
    if (!ref) return
    await visitDefinitionSource(editor, ref)
  }, "Visit the source of any registered Jemacs definition.")

  editor.command("help-follow", async ({ buffer, editor }) => {
    const button = helpButtonAt(buffer)
    if (button) {
      await followHelpButton(editor, button)
      return
    }
    const source = parseSourceLineAtPoint(buffer.text, buffer.point)
    if (source) {
      await visitSource(editor, source)
      return
    }
    const topic = buffer.locals.get(HELP_TOPIC_KEY) as HelpTopic | undefined
    if (!topic) {
      editor.message("Nothing to follow here")
      return
    }
    if (topic.kind === "definition") {
      await visitDefinitionSource(editor, topic.ref)
      return
    }
    if (topic.kind === "command") await editor.run("find-function", [topic.name])
    else if (topic.kind === "variable") await editor.run("describe-variable", [topic.name])
    else if (topic.kind === "mode") await editor.run("describe-mode", [topic.name])
    else if (topic.kind === "key") await visitDefinitionSource(editor, { kind: "key", name: topic.sequence, detail: topic.map })
  }, "Follow a help cross-reference.")
  editor.command("help-follow-symbol", async ({ buffer, editor }) => {
    const button = helpButtonAt(buffer)
    if (!button) {
      editor.message("No help button at point")
      return
    }
    await followHelpButton(editor, button)
  }, "Follow the help symbol button at point.")
  editor.command("push-button", async ({ editor }) => {
    await editor.run("help-follow")
  }, "Activate the button at point.")
  editor.command("forward-button", ({ buffer, editor }) => {
    if (!moveHelpButton(buffer, 1)) editor.message("No next button")
  }, "Move point to the next button.")
  editor.command("backward-button", ({ buffer, editor }) => {
    if (!moveHelpButton(buffer, -1)) editor.message("No previous button")
  }, "Move point to the previous button.")
  editor.command("help-revert", async ({ editor }) => {
    const page = currentHelpPage(editor)
    if (!page) {
      editor.message("No help page to revert")
      return
    }
    await rerenderHelpPage(editor, page)
  }, "Re-render the current help page.")
  editor.command("help-go-back", async ({ editor }) => {
    const history = currentHelpHistory(editor)
    if (!history || history.index <= 0) {
      editor.message("No previous help for this buffer")
      return
    }
    history.index--
    await rerenderHelpPage(editor, history.entries[history.index]!)
  }, "Go back to the previous help page.")
  editor.command("help-go-forward", async ({ editor }) => {
    const history = currentHelpHistory(editor)
    if (!history || history.index >= history.entries.length - 1) {
      editor.message("No following help for this buffer")
      return
    }
    history.index++
    await rerenderHelpPage(editor, history.entries[history.index]!)
  }, "Go forward to the next help page.")

  editor.command("eval-defun", async ({ buffer, editor }) => {
    const region = extractTopLevelForm(buffer.text, buffer.point)
    if (!region) {
      editor.message("No definition at point")
      return
    }
    const ref = await evalDefinitionForm(editor, evaluator, region.text, buffer.path ?? `${buffer.name}:eval-defun`)
    editor.message(ref ? `Evaluated ${ref.kind} ${ref.name}` : "Evaluated form at point")
  }, "Evaluate the definition at point and patch the live editor.")

  editor.command("eval-buffer", async ({ buffer, editor }) => {
    if (buffer.path) {
      await editor.run("load-file", [buffer.path])
      return
    }
    const result = await evaluator.eval(buffer.text, buffer.name)
    editor.message(`Evaluated buffer => ${String(result)}`)
  }, "Evaluate or reload the current buffer.")

  editor.command("load-file", async ({ editor, args }) => {
    const path = args[0] ?? await editor.completingRead("Load file: ", { completion: "file", history: "file" })
    if (!path) return
    revertAllDefinitions(editor)
    const mod = await evaluator.loadModule(path)
    if (typeof mod.install === "function") await evaluator.loadPlugin(path)
    else if (typeof mod.installDefaultConfig === "function") mod.installDefaultConfig(editor)
    else if (typeof mod.installDefaultCommands === "function") mod.installDefaultCommands(editor)
    else await evaluator.eval(await readBufferFile(path), path)
    editor.message(`Loaded ${path}`)
  }, "Load a TypeScript/JavaScript file into the live editor.")

  editor.command("jemacs-revert-function", ({ editor, args }) => {
    const ref = args[0]
      ? ({ kind: "command", name: args[0] } satisfies DefinitionRef)
      : helpTopicRef(editor) ?? { kind: "command", name: editor.commands.names().find(n => editor.commands.get(n)?.patched) ?? "" }
    if (!ref.name) {
      editor.message("No patched definition to revert")
      return
    }
    if (!revertDefinition(editor, ref)) editor.message(`Could not revert ${ref.name}`)
    else editor.message(`Reverted ${ref.kind} ${ref.name}`)
  }, "Restore a temporarily patched command (alias: jemacs-revert-definition).")

  editor.command("jemacs-revert-definition", async ({ editor, args }) => {
    const label = args[0] ?? await pickPatchedDefinition(editor)
    if (!label) return
    const ref = parseDefinitionLabel(label)
    if (!ref || !revertDefinition(editor, ref)) editor.message("Could not revert definition")
    else editor.message(`Reverted ${ref.kind} ${ref.name}`)
  }, "Restore any temporarily patched definition to its baseline.")

  editor.command("jemacs-revert-all-definitions", ({ editor }) => {
    const n = revertAllDefinitions(editor)
    editor.message(`Reverted ${n} patched definition(s)`)
  }, "Restore all patched commands and variables.")

  editor.command("describe-function", async ({ editor, args }) => {
    const name = args[0] ?? await editor.completingRead("Describe function: ", { collection: editor.commands.names(), history: "command" })
    if (!name) return
    const spec = editor.commands.get(name)
    showHelp(editor, spec ? formatDescribeFunction(spec) : `No command named ${name}`, { kind: "command", name }, {
      command: "describe-function",
      args: [name],
    })
  }, "Describe an interactive command and link to its source.")

  editor.command("describe-variable", async ({ editor, args }) => {
    const name = args[0] ?? await editor.completingRead("Describe variable: ", {
      collection: listCustomVariables().map(v => v.name),
      history: "variable",
    })
    if (!name) return
    const variable = getCustomVariable(name)
    showHelp(editor, variable ? formatDescribeVariable(variable) : `No variable named ${name}`, { kind: "variable", name }, {
      command: "describe-variable",
      args: [name],
    })
  }, "Describe a custom variable and link to its source.")

  editor.command("describe-key", async ({ editor, args }) => {
    const sequence = args.join(" ") || await editor.readKeySequence("Describe key (or click or menu item): ")
    if (!sequence) return
    const body = editor.describeKey(sequence)
    const normalized = normalizeSequence(sequence)
    const binding = listKeyBindings().find(b => normalizeSequence(b.sequence) === normalized)
    const extra = binding?.source ? `\n\n${formatSourceLine(binding.source)}\nRET — visit source` : ""
    showHelp(editor, body + extra, binding
      ? { kind: "key", map: binding.map, sequence: binding.sequence }
      : { kind: "command", name: editor.keymap.get(sequence) ?? "" }, {
        command: "describe-key",
        args: [sequence],
      })
  }, "Describe a key binding and its source.")

  editor.command("describe-key-briefly", async ({ editor, args }) => {
    const sequence = args.join(" ") || await editor.readKeySequence("Describe key briefly: ")
    if (!sequence) return
    editor.message(editor.describeKeyBriefly(sequence))
  }, "Print the name of the function a key invokes.")

  editor.command("apropos-variable", async ({ editor, args }) => {
    const pattern = args[0] ?? await editor.prompt("Apropos variable: ", "", "apropos")
    if (!pattern) return
    const re = new RegExp(pattern, "i")
    const lines = listCustomVariables()
      .filter(v => re.test(v.name) || re.test(v.doc ?? ""))
      .map(v => `${v.name.padEnd(28)} ${String(v.value)}`)
    showHelp(editor, lines.join("\n") || "No matches", { kind: "variable", name: pattern }, {
      command: "apropos-variable",
      args: [pattern],
    })
  }, "Show custom variables matching a pattern.")

  editor.command("describe-mode", ({ buffer, editor, args }) => {
    const name = args[0] ?? buffer.mode
    const def = getMode(name)
    const entry = getCatalogEntry({ kind: "mode", name })
    const lines = [
      `Major mode: ${name}`,
      def?.parent ? `Parent: ${def.parent}` : "",
      entry?.source ? formatSourceLine(entry.source) : "",
      entry?.source ? "RET — visit source" : "",
      !args[0] && editor.activeMinorModes(buffer).length ? `Minor modes: ${editor.activeMinorModes(buffer).map(m => m.name).join(", ")}` : "",
    ].filter(Boolean)
    showHelp(editor, lines.join("\n"), { kind: "mode", name }, {
      command: "describe-mode",
      args: [name],
    })
  }, "Describe major mode and link to its source.")
}

export function showHelp(editor: Editor, body: string, topic: HelpTopic, page?: HelpPage): void {
  const existing = helpBuffer(editor)
  const history = existing ? ensureHelpHistory(existing) : null
  const help = editor.scratch("*Help*", body, "help")
  help.locals.set(HELP_TOPIC_KEY, topic)
  help.locals.set(HELP_BUTTONS_KEY, helpButtonsFor(editor, body))
  if (!page) return
  const nextHistory = history ?? ensureHelpHistory(help)
  if (!nextHistory.navigating) pushHelpHistory(nextHistory, page)
  help.locals.set(HELP_HISTORY_KEY, nextHistory)
}

function formatDescribeVariable(variable: CustomVariable): string {
  const lines = [
    variable.name,
    "",
    `Type: ${variable.type}`,
    `Value: ${JSON.stringify(variable.value)}`,
    variable.doc ?? "",
    "",
  ]
  if (variable.source) {
    lines.push(formatSourceLine(variable.source))
    lines.push("RET — visit source and edit")
    lines.push("")
  }
  if (variable.patched) lines.push("Status: temporarily patched (M-x jemacs-revert-definition)")
  return lines.filter((line, i) => i > 0 || line.length > 0).join("\n")
}

async function visitDefinitionSource(editor: Editor, ref: DefinitionRef): Promise<void> {
  let source = getCatalogEntry(ref)?.source
  if (ref.kind === "command") source = editor.commands.get(ref.name)?.source ?? source
  if (ref.kind === "variable") source = getCustomVariable(ref.name)?.source ?? source
  if (ref.kind === "key") source = getKeyBinding(ref.detail ?? "global-map", ref.name)?.source ?? source
  if (!source) {
    editor.message(`No source location for ${ref.kind} ${ref.name}`)
    return
  }
  await visitSource(editor, source)
}

async function pickDefinition(editor: Editor): Promise<string | null> {
  const items = listCatalogEntries().map(e => formatDefinitionLabel(e))
  if (!items.length) return null
  return editor.completingRead("Find definition: ", { collection: items, history: "definition" })
}

async function pickPatchedDefinition(editor: Editor): Promise<string | null> {
  const items = listCatalogEntries().filter(e => e.patched).map(e => formatDefinitionLabel(e))
  if (!items.length) return null
  return editor.completingRead("Revert definition: ", { collection: items })
}

function formatDefinitionLabel(entry: { kind: DefinitionKind; name: string; detail?: string }): string {
  return entry.detail ? `${entry.kind}:${entry.name}@${entry.detail}` : `${entry.kind}:${entry.name}`
}

function parseDefinitionLabel(label: string): DefinitionRef | null {
  const match = label.match(/^(\w+):([^@]+)(?:@(.+))?$/)
  if (!match) return null
  return { kind: match[1] as DefinitionKind, name: match[2]!, detail: match[3] }
}

export function helpTopicRef(editor: Editor): DefinitionRef | null {
  const topic = editor.currentBuffer.locals.get(HELP_TOPIC_KEY) as HelpTopic | undefined
  if (!topic) return null
  if (topic.kind === "definition") return topic.ref
  if (topic.kind === "command") return { kind: "command", name: topic.name }
  if (topic.kind === "variable") return { kind: "variable", name: topic.name }
  if (topic.kind === "mode") return { kind: "mode", name: topic.name }
  if (topic.kind === "key") return { kind: "key", name: topic.sequence, detail: topic.map }
  return null
}

export function helpTopicName(editor: Editor): string | undefined {
  const ref = helpTopicRef(editor)
  return ref?.name
}

function helpBuffer(editor: Editor) {
  return [...editor.buffers.values()].find(buffer => buffer.name === "*Help*")
}

function ensureHelpHistory(buffer: { locals: Map<string, unknown> }): HelpHistory {
  let history = buffer.locals.get(HELP_HISTORY_KEY) as HelpHistory | undefined
  if (!history) {
    history = { entries: [], index: -1 }
    buffer.locals.set(HELP_HISTORY_KEY, history)
  }
  return history
}

function currentHelpHistory(editor: Editor): HelpHistory | null {
  if (editor.currentBuffer.name !== "*Help*") return null
  return editor.currentBuffer.locals.get(HELP_HISTORY_KEY) as HelpHistory | undefined ?? null
}

function currentHelpPage(editor: Editor): HelpPage | null {
  const history = currentHelpHistory(editor)
  return history ? history.entries[history.index] ?? null : null
}

function pushHelpHistory(history: HelpHistory, page: HelpPage): void {
  const current = history.entries[history.index]
  if (current && sameHelpPage(current, page)) return
  history.entries = history.entries.slice(0, history.index + 1)
  history.entries.push(page)
  history.index = history.entries.length - 1
}

function sameHelpPage(a: HelpPage, b: HelpPage): boolean {
  return a.command === b.command && a.args.length === b.args.length && a.args.every((arg, i) => arg === b.args[i])
}

async function rerenderHelpPage(editor: Editor, page: HelpPage): Promise<void> {
  const history = currentHelpHistory(editor)
  if (history) history.navigating = true
  try {
    await editor.run(page.command, page.args)
  } finally {
    const next = currentHelpHistory(editor)
    if (next) next.navigating = false
  }
}

async function followHelpButton(editor: Editor, button: HelpButton): Promise<void> {
  if (button.kind === "command") await editor.run("describe-function", [button.name])
  else await editor.run("describe-variable", [button.name])
}

function helpButtonsFor(editor: Editor, text: string): HelpButton[] {
  const known = [
    ...editor.commands.names().map(name => ({ kind: "command" as const, name })),
    ...listCustomVariables().map(variable => ({ kind: "variable" as const, name: variable.name })),
  ].sort((a, b) => b.name.length - a.name.length || a.name.localeCompare(b.name))
  const buttons: HelpButton[] = []
  const occupied: Array<{ start: number; end: number }> = []
  for (const item of known) {
    if (!item.name) continue
    const re = new RegExp(escapeRegExp(item.name), "g")
    for (const match of text.matchAll(re)) {
      const start = match.index ?? 0
      const end = start + item.name.length
      if (!symbolBoundary(text[start - 1]) || !symbolBoundary(text[end])) continue
      if (occupied.some(range => start < range.end && end > range.start)) continue
      occupied.push({ start, end })
      buttons.push({ start, end, kind: item.kind, name: item.name })
    }
  }
  return buttons.sort((a, b) => a.start - b.start || a.end - b.end)
}

function symbolBoundary(ch: string | undefined): boolean {
  return ch == null || !/[A-Za-z0-9_-]/.test(ch)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

async function readBufferFile(path: string): Promise<string> {
  const { readFileText } = await import("../platform/runtime")
  return readFileText(path)
}
