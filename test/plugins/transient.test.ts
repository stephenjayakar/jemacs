import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildDisplayModel } from "../../src/display/build-display-model"
import type { Editor, TransientDefinition } from "../../src/kernel/editor"
import { getCustom, setCustom } from "../../src/runtime/custom"
import { keySeq, parseKey } from "../harness"
import { makeEditor } from "./helper"

async function withTempTransientValuesFile(fn: (file: string) => Promise<void>): Promise<void> {
  const previous = getCustom<string>("transient-values-file")
  const dir = await mkdtemp(join(tmpdir(), "jemacs-transient-"))
  const file = join(dir, "transient.json")
  setCustom("transient-values-file", file)
  try {
    await fn(file)
  } finally {
    if (previous !== undefined) setCustom("transient-values-file", previous)
    await rm(dir, { recursive: true, force: true })
  }
}

const demoTransient: TransientDefinition = {
  name: "demo",
  title: "Demo Popup",
  groups: [
    {
      title: "Arguments",
      infixes: [
        { key: "- x", label: "extra", argument: "--extra" },
      ],
    },
    {
      title: "Actions",
      suffixes: [
        { key: "a", label: "act", command: "demo-act" },
      ],
    },
  ],
}

test("transient opens, renders, toggles infixes, and dispatches suffix args", async () => {
  const editor = makeEditor()
  let seen: string[] = []
  editor.command("demo-act", ({ args }) => { seen = args })

  editor.openTransient(demoTransient)
  expect(editor.transientDisplayText()).toContain("Demo Popup")
  expect(editor.transientDisplayText()).toContain("extra (--extra)")
  expect(editor.minibufferCompletionDisplay).toBeNull()

  expect((await editor.handleKey({ name: "-", sequence: "-" })).status).toBe("pending")
  expect((await editor.handleKey({ name: "x", sequence: "x" })).status).toBe("command")
  expect(editor.transientDisplayText()).toContain("extra (--extra)")

  const result = await editor.handleKey({ name: "a", sequence: "a" })
  expect(result.status).toBe("command")
  expect(result.status === "command" && result.command).toBe("demo-act")
  expect(seen).toEqual(["--extra"])
  expect(editor.transient).toBeNull()
  expect(editor.transientDisplayText()).toBeNull()
  expect(editor.minibufferCompletionDisplay).toBeNull()
})

test("bare q is not an implicit transient quit key, but explicit q bindings still work", async () => {
  const editor = makeEditor()
  let message = ""
  let ran = 0
  editor.events.on("message", ({ text }) => { message = text })
  editor.command("explicit-q", () => { ran++ })

  editor.openTransient(demoTransient)
  const result = await editor.handleKey(parseKey("q"))

  expect(result.status).toBe("unmatched")
  expect(message).toContain("No transient binding: q")
  expect(editor.transient?.definition.name).toBe("demo")

  await keySeq(editor, "C-g")
  editor.openTransient({
    name: "explicit-q",
    title: "Explicit q",
    groups: [{ title: "Actions", suffixes: [{ key: "q", label: "quit", command: "explicit-q" }] }],
  })
  await keySeq(editor, "q")

  expect(ran).toBe(1)
  expect(editor.transient).toBeNull()
})

test("explicit transient quit suffix commands manipulate the transient stack", async () => {
  const editor = makeEditor()
  const child: TransientDefinition = {
    name: "quit-child",
    title: "Quit Child",
    groups: [{
      title: "Actions",
      suffixes: [
        { key: "q", label: "quit one", command: "transient-quit-one" },
        { key: "S-q", label: "quit all", command: "transient-quit-all" },
      ],
    }],
  }

  editor.openTransient(parentTransient)
  editor.openTransient(child)
  await keySeq(editor, "q")
  expect(editor.transient?.definition.name).toBe("parent")

  editor.openTransient(child)
  await keySeq(editor, "S-q")
  expect(editor.transient).toBeNull()
})

test("transient prefix arguments stay open and are passed to the next suffix", async () => {
  const editor = makeEditor()
  let seen: number | null | undefined
  editor.command("prefix-act", ({ prefixArgument }) => { seen = prefixArgument })
  const definition: TransientDefinition = {
    name: "prefix-demo",
    title: "Prefix Demo",
    groups: [{ title: "Actions", suffixes: [{ key: "a", label: "act", command: "prefix-act" }] }],
  }

  editor.openTransient(definition)
  await keySeq(editor, "C-u")
  expect(editor.transient?.definition.name).toBe("prefix-demo")
  expect(editor.transientDisplayText()).toContain("prefix: 4")

  await keySeq(editor, "3")
  expect(editor.transient?.definition.name).toBe("prefix-demo")
  expect(editor.transientDisplayText()).toContain("prefix: 3")
  expect(seen).toBeUndefined()

  await keySeq(editor, "a")
  expect(seen).toBe(3)
  expect(editor.transient).toBeNull()
})

test("transient cancellation clears popup without running a suffix", async () => {
  const editor = makeEditor()
  let ran = false
  editor.command("demo-act", () => { ran = true })

  editor.openTransient(demoTransient)
  const result = await editor.handleKey({ name: "g", ctrl: true })
  expect(result.status).toBe("command")
  expect(editor.transient).toBeNull()
  expect(editor.transientDisplayText()).toBeNull()
  expect(editor.minibufferCompletionDisplay).toBeNull()
  expect(ran).toBe(false)
})

test("transient value prompt suspends and restores transient state", async () => {
  const valueTransient: TransientDefinition = {
    name: "value-test",
    title: "Value Test",
    groups: [
      {
        title: "Arguments",
        infixes: [
          { key: "- v", label: "val", argument: "--val", kind: "value", defaultValue: "" },
        ],
      },
    ],
  }

  const editor = makeEditor()
  editor.openTransient(valueTransient)

  // Start the value editing sequence: press "-" then "v"
  await editor.handleKey({ name: "-", sequence: "-" })
  
  // This handleKey will trigger the prompt
  const promise = editor.handleKey({ name: "v", sequence: "v" })

  // Wait a tick for prompt to create the minibuffer
  await new Promise(resolve => setTimeout(resolve, 10))

  // Minibuffer should be active and transient suspended (set to null temporarily)
  expect(editor.minibuffer).not.toBeNull()
  expect(editor.transient).toBeNull()

  // Standard editing keys can flow to the minibuffer
  await editor.handleKey({ name: "a", sequence: "a" })
  await editor.handleKey({ name: "b", sequence: "b" })
  expect(editor.activeBuffer.text).toBe("ab")

  // Backspace should delete a character
  await editor.handleKey({ name: "backspace", sequence: "\x7f" })
  expect(editor.activeBuffer.text).toBe("a")

  // Submit minibuffer
  await editor.handleKey({ name: "enter", sequence: "\r" })
  await promise

  // Transient should be restored with the typed value and minibuffer closed
  expect(editor.minibuffer).toBeNull()
  expect(editor.transient).not.toBeNull()
  expect(editor.transient?.values.get("--val")).toBe("a")
})

test("unknown transient key reports a message and keeps the popup active", async () => {
  const editor = makeEditor()
  let message = ""
  editor.events.on("message", ({ text }) => { message = text })

  editor.openTransient(demoTransient)
  const result = await editor.handleKey({ name: "z", sequence: "z" })

  expect(result.status).toBe("unmatched")
  expect(message).toContain("No transient binding: z")
  expect(editor.transient?.definition.name).toBe("demo")
  expect(editor.transientDisplayText()).toContain("Demo Popup")
  expect(editor.minibufferCompletionDisplay).toBeNull()
})

test("display model allocates bottom rows for transient popup", () => {
  const editor = makeEditor()
  const before = buildDisplayModel(editor, {
    viewport: { rows: 12, cols: 80 },
  })
  if (before.windows.kind !== "leaf") throw new Error("expected leaf")
  editor.openTransient(demoTransient)

  const model = buildDisplayModel(editor, {
    viewport: { rows: 12, cols: 80 },
  })

  expect(model.windows.kind).toBe("leaf")
  if (model.windows.kind !== "leaf") return
  const footerText = model.windows.pane.footer?.chunks.map(c => c.text).join("") ?? ""
  expect(footerText).toContain("Demo Popup")
  expect(model.windows.pane.bodyLineBudget).toBeLessThan(before.windows.pane.bodyLineBudget)
  expect(model.minibufferCompletionLines).toBe(0)
  expect(model.minibufferCompletions.chunks.map(c => c.text).join("")).not.toContain("Demo Popup")
  expect(model.minibuffer.chunks.map(c => c.text).join("")).toBe(" ")
})

test("transient footer is local to invoking split window", async () => {
  const editor = makeEditor()
  const initial = buildDisplayModel(editor, { viewport: { rows: 16, cols: 80 } })
  if (initial.windows.kind !== "leaf") throw new Error("expected leaf")

  await editor.run("split-window-below")
  const invokingWindowId = editor.selectedWindowId
  editor.openTransient(demoTransient)

  const model = buildDisplayModel(editor, { viewport: { rows: 16, cols: 80 } })
  expect(model.windows.kind).toBe("split")
  if (model.windows.kind !== "split") return
  expect(model.minibufferCompletionLines).toBe(0)
  expect(model.windows.first.kind).toBe("leaf")
  expect(model.windows.second.kind).toBe("leaf")
  if (model.windows.first.kind !== "leaf" || model.windows.second.kind !== "leaf") return
  const first = model.windows.first.pane
  const second = model.windows.second.pane
  const owner = first.id === invokingWindowId ? first : second
  const other = first.id === invokingWindowId ? second : first
  expect(owner.footer?.chunks.map(c => c.text).join("")).toContain("Demo Popup")
  expect(other.footer).toBeUndefined()
  expect(owner.bodyLineBudget).toBeLessThan(other.bodyLineBudget)
})

const parentTransient: TransientDefinition = {
  name: "parent",
  title: "Parent Popup",
  groups: [
    {
      title: "Arguments",
      infixes: [
        { key: "- x", label: "extra", argument: "--extra" },
      ],
    },
  ],
}

const childTransient: TransientDefinition = {
  name: "child",
  title: "Child Popup",
  groups: [
    {
      title: "Actions",
      suffixes: [
        { key: "r", label: "return", command: "child-return", transient: "return" },
      ],
    },
  ],
}

test("nested openTransient keeps parent values and C-g returns to parent", async () => {
  const editor = makeEditor()

  editor.openTransient(parentTransient)
  await keySeq(editor, "-", "x")
  editor.openTransient(childTransient)

  expect(editor.transient?.definition.name).toBe("child")
  await keySeq(editor, "C-g")

  expect(editor.transient?.definition.name).toBe("parent")
  expect(editor.transientDisplayText()).toContain("extra (--extra)")
})

test("C-q closes the whole transient stack", async () => {
  const editor = makeEditor()

  editor.openTransient(parentTransient)
  await keySeq(editor, "-", "x")
  editor.openTransient(childTransient)
  await keySeq(editor, "C-q")

  expect(editor.transient).toBeNull()
  expect(editor.transientDisplayText()).toBeNull()
})

test("C-z suspends the stack and transient-resume restores it", async () => {
  const editor = makeEditor()

  editor.openTransient(parentTransient)
  await keySeq(editor, "-", "x")
  editor.openTransient(childTransient)
  await keySeq(editor, "C-z")

  expect(editor.transient).toBeNull()

  await editor.run("transient-resume")
  expect(editor.transient?.definition.name).toBe("child")

  await keySeq(editor, "C-g")
  expect(editor.transient?.definition.name).toBe("parent")
  expect(editor.transientDisplayText()).toContain("extra (--extra)")
})

test("suffix transient stay keeps popup open after running command", async () => {
  const editor = makeEditor()
  let ran = 0
  editor.command("stay-act", () => { ran++ })
  const definition: TransientDefinition = {
    name: "stay",
    title: "Stay Popup",
    groups: [
      {
        title: "Actions",
        suffixes: [
          { key: "s", label: "stay", command: "stay-act", transient: "stay" },
        ],
      },
    ],
  }

  editor.openTransient(definition)
  await keySeq(editor, "s")

  expect(ran).toBe(1)
  expect(editor.transient?.definition.name).toBe("stay")
})

test("suffix transient return runs command and pops to parent", async () => {
  const editor = makeEditor()
  let ran = 0
  editor.command("child-return", () => { ran++ })

  editor.openTransient(parentTransient)
  editor.openTransient(childTransient)
  await keySeq(editor, "r")

  expect(ran).toBe(1)
  expect(editor.transient?.definition.name).toBe("parent")
})

test("choice infix cycles through choices and back to unset", async () => {
  const editor = makeEditor()
  let seen: string[] = []
  editor.command("choice-act", ({ args }) => { seen = args })
  const definition: TransientDefinition = {
    name: "choice",
    title: "Choice Popup",
    groups: [
      {
        title: "Arguments",
        infixes: [
          { key: "m", label: "mode", argument: "--mode", choices: ["one", "two"] },
        ],
      },
      {
        title: "Actions",
        suffixes: [
          { key: "a", label: "act", command: "choice-act" },
        ],
      },
    ],
  }

  editor.openTransient(definition)
  await keySeq(editor, "m")
  expect(editor.transientDisplayText()).toContain("mode (--mode one)")
  await keySeq(editor, "m")
  expect(editor.transientDisplayText()).toContain("mode (--mode two)")
  await keySeq(editor, "m")
  expect(editor.transientDisplayText()).toContain("mode (--mode)")

  await keySeq(editor, "a")
  expect(seen).toEqual([])
})

test("value infix re-prompts with current value, C-g preserves it, and empty clears it", async () => {
  const editor = makeEditor()
  const definition: TransientDefinition = {
    name: "value",
    title: "Value Popup",
    groups: [
      {
        title: "Arguments",
        infixes: [
          { key: "v", label: "value", argument: "--value", kind: "value", prompt: "Value: " },
        ],
      },
    ],
  }

  editor.openTransient(definition)
  const first = editor.handleKey(parseKey("v"))
  expect(editor.minibuffer?.prompt).toBe("Value: ")
  await editor.minibufferInsert("7")
  editor.minibufferSubmit()
  await first
  expect(editor.transientDisplayText()).toContain("value (--value 7)")

  const cancel = editor.handleKey(parseKey("v"))
  expect(editor.minibufferInput()).toBe("7")
  await keySeq(editor, "C-g")
  await cancel
  expect(editor.transientDisplayText()).toContain("value (--value 7)")

  const clear = editor.handleKey(parseKey("v"))
  expect(editor.minibufferInput()).toBe("7")
  editor.minibufferAccept("")
  await clear
  expect(editor.transientDisplayText()).toContain("value (--value)")
  expect(editor.transientDisplayText()).not.toContain("--value=7")
})

test("equals style value infix exports argument=value token", async () => {
  const editor = makeEditor()
  let seen: string[] = []
  editor.command("equals-act", ({ args }) => { seen = args })
  editor.prompt = async () => "5"
  const definition: TransientDefinition = {
    name: "equals",
    title: "Equals Popup",
    groups: [
      {
        title: "Arguments",
        infixes: [
          { key: "m", label: "max", argument: "--max-count", kind: "value", style: "equals" },
        ],
      },
      {
        title: "Actions",
        suffixes: [
          { key: "a", label: "act", command: "equals-act" },
        ],
      },
    ],
  }

  editor.openTransient(definition)
  await keySeq(editor, "m", "a")

  expect(seen).toEqual(["--max-count=5"])
})

test("pending transient keys are echoed and C-g clears pending only", async () => {
  const editor = makeEditor()

  editor.openTransient(demoTransient)
  await keySeq(editor, "-")

  expect(editor.transient?.pending).toEqual(["-"])
  expect(editor.transientDisplayText()).toContain("-- pending: - ")

  await keySeq(editor, "C-g")

  expect(editor.transient?.definition.name).toBe("demo")
  expect(editor.transient?.pending).toEqual([])
  expect(editor.transientDisplayText()).not.toContain("-- pending:")
})

test("transient help mode describes a multi-key suffix and stays open", async () => {
  const editor = makeEditor()
  let message = ""
  editor.events.on("message", ({ text }) => { message = text })
  editor.command("multi-act", () => {}, "Registered command description.")
  const definition: TransientDefinition = {
    name: "help-demo",
    title: "Help Demo",
    groups: [
      {
        title: "Actions",
        suffixes: [
          { key: "C-c a", label: "act", command: "multi-act" },
        ],
      },
    ],
  }

  editor.openTransient(definition)
  await keySeq(editor, "C-h")
  expect(message).toBe("Describe key: ")
  await keySeq(editor, "C-c")
  expect(message).toBe("Describe key: C-c")
  await keySeq(editor, "a")

  expect(message).toBe("Registered command description.")
  expect(editor.transient?.definition.name).toBe("help-demo")
})

test("transient help C-g cancels help mode without closing the transient", async () => {
  const editor = makeEditor()
  let ran = 0
  let message = ""
  editor.events.on("message", ({ text }) => { message = text })
  editor.command("demo-act", () => { ran++ })

  editor.openTransient(demoTransient)
  await keySeq(editor, "C-h", "C-g")

  expect(message).toBe("Quit")
  expect(editor.transient?.definition.name).toBe("demo")

  await keySeq(editor, "a")
  expect(ran).toBe(1)
  expect(editor.transient).toBeNull()
})

test("transient C-x footer lists common commands only while C-x is pending", async () => {
  const editor = makeEditor()
  editor.openTransient(demoTransient)

  expect(editor.transientDisplayText()).not.toContain("C-x s set")

  await keySeq(editor, "C-x")
  expect(editor.transientDisplayText()).toContain("-- pending: C-x ")
  expect(editor.transientDisplayText()).toContain("C-x s set")

  await keySeq(editor, "C-g")
  expect(editor.transientDisplayText()).not.toContain("C-x s set")
})

test("transient-set makes values survive reopen within the session", async () => {
  const editor = makeEditor()

  editor.openTransient(demoTransient)
  await keySeq(editor, "-", "x", "C-x", "s", "C-g")
  expect(editor.transient).toBeNull()

  editor.openTransient(demoTransient)
  expect(editor.transientDisplayText()).toContain("extra (--extra)")
})

test("transient-save persists values across editors", async () => {
  const editor = makeEditor()
  await withTempTransientValuesFile(async file => {
    editor.openTransient(demoTransient)
    await keySeq(editor, "-", "x", "C-x", "C-s")

    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, Record<string, boolean | string>>
    expect(raw.demo?.["--extra"]).toBe(true)

    const fresh = makeEditor()
    setCustom("transient-values-file", file)
    fresh.openTransient(demoTransient)
    expect(fresh.transientDisplayText()).toContain("extra (--extra)")
  })
})

test("transient-reset restores defaults and removes session and saved values", async () => {
  const editor = makeEditor()
  await withTempTransientValuesFile(async file => {
    editor.openTransient(demoTransient)
    await keySeq(editor, "-", "x", "C-x", "C-s")
    expect(editor.transientDisplayText()).toContain("extra (--extra)")

    await keySeq(editor, "C-x", "C-r")
    expect(editor.transientDisplayText()).toContain("extra (--extra)")

    await keySeq(editor, "C-g")
    editor.openTransient(demoTransient)
    expect(editor.transientDisplayText()).toContain("extra (--extra)")

    const fresh = makeEditor()
    setCustom("transient-values-file", file)
    fresh.openTransient(demoTransient)
    expect(fresh.transientDisplayText()).toContain("extra (--extra)")
  })
})

test("transient history cycles older and newer value snapshots", async () => {
  const editor = makeEditor()
  let seen: string[][] = []
  editor.command("history-act", ({ args }) => { seen.push(args) })
  const definition: TransientDefinition = {
    name: "history",
    title: "History Popup",
    groups: [
      {
        title: "Arguments",
        infixes: [
          { key: "m", label: "mode", argument: "--mode", choices: ["one", "two"] },
        ],
      },
      {
        title: "Actions",
        suffixes: [
          { key: "a", label: "act", command: "history-act" },
        ],
      },
    ],
  }

  editor.openTransient(definition)
  await keySeq(editor, "m", "a")
  editor.openTransient(definition)
  await keySeq(editor, "m", "m", "a")
  expect(seen).toEqual([["--mode", "one"], ["--mode", "two"]])

  editor.openTransient(definition)
  await keySeq(editor, "C-x", "p")
  expect(editor.transientDisplayText()).toContain("mode (--mode two)")
  await keySeq(editor, "C-x", "p")
  expect(editor.transientDisplayText()).toContain("mode (--mode one)")
  await keySeq(editor, "C-x", "n")
  expect(editor.transientDisplayText()).toContain("mode (--mode two)")
})

test("explicit C-h transient binding runs instead of entering help mode", async () => {
  const editor = makeEditor()
  let ran = 0
  let message = ""
  editor.events.on("message", ({ text }) => { message = text })
  editor.command("explicit-help", () => { ran++ })
  const definition: TransientDefinition = {
    name: "explicit-help",
    title: "Explicit Help",
    groups: [
      {
        title: "Actions",
        suffixes: [
          { key: "C-h", label: "help", command: "explicit-help" },
        ],
      },
    ],
  }

  editor.openTransient(definition)
  await keySeq(editor, "C-h")

  expect(ran).toBe(1)
  expect(message).not.toBe("Describe key: ")
  expect(editor.transient).toBeNull()
})

test("transient levels hide and unbind entries until the active level changes", async () => {
  const editor = makeEditor()
  const previous = getCustom<number>("transient-default-level") ?? 4
  let ran = 0
  editor.command("level-high", () => { ran++ })
  const definition: TransientDefinition = {
    name: "levels",
    title: "Levels",
    groups: [
      { title: "Base", suffixes: [{ key: "b", label: "base", command: "level-high", transient: "stay" }] },
      { title: "Advanced", level: 5, suffixes: [{ key: "h", label: "high", command: "level-high", transient: "stay" }] },
    ],
  }

  try {
    setCustom("transient-default-level", 4)
    editor.openTransient(definition)
    expect(editor.transientDisplayText()).toContain("base")
    expect(editor.transientDisplayText()).not.toContain("high")
    expect((await editor.handleKey(parseKey("h"))).status).toBe("unmatched")
    expect(ran).toBe(0)

    setCustom("transient-default-level", 5)
    expect(editor.transientDisplayText()).toContain("high")
    await keySeq(editor, "h")
    expect(ran).toBe(1)
    expect(editor.transient?.definition.name).toBe("levels")
  } finally {
    setCustom("transient-default-level", previous)
  }
})

test("transient if predicates hide and unbind entries on each render", async () => {
  const editor = makeEditor()
  let visible = false
  let ran = 0
  editor.command("predicate-act", () => { ran++ })
  const definition: TransientDefinition = {
    name: "predicate",
    title: "Predicate",
    groups: [{
      title: "Actions",
      suffixes: [{ key: "p", label: "predicate", command: "predicate-act", transient: "stay", if: () => visible }],
    }],
  }

  editor.openTransient(definition)
  expect(editor.transientDisplayText()).not.toContain("predicate")
  expect((await editor.handleKey(parseKey("p"))).status).toBe("unmatched")
  expect(ran).toBe(0)

  visible = true
  expect(editor.transientDisplayText()).toContain("predicate")
  await keySeq(editor, "p")
  expect(ran).toBe(1)
  expect(editor.transient?.definition.name).toBe("predicate")
})

test("transient inapt suffix renders, warns, does not run, and stays open", async () => {
  const editor = makeEditor()
  let ran = 0
  let message = ""
  editor.events.on("message", ({ text }) => { message = text })
  editor.command("inapt-act", () => { ran++ })
  const definition: TransientDefinition = {
    name: "inapt",
    title: "Inapt",
    groups: [{
      title: "Actions",
      suffixes: [{ key: "i", label: "blocked", command: "inapt-act", inaptIf: () => true }],
    }],
  }

  editor.openTransient(definition)
  expect(editor.transientDisplayText()).toContain("blocked")
  await keySeq(editor, "i")

  expect(message).toBe("Suffix blocked is not applicable")
  expect(ran).toBe(0)
  expect(editor.transient?.definition.name).toBe("inapt")
})

test("transient column groups render subgroups side by side", () => {
  const editor = makeEditor()
  const definition: TransientDefinition = {
    name: "columns",
    title: "Columns",
    groups: [{
      title: "Actions",
      subgroups: [
        { title: "Left", suffixes: [{ key: "a", label: "left action", command: "ignore" }] },
        { title: "Right", suffixes: [{ key: "b", label: "right action", command: "ignore" }] },
      ],
    }],
  }

  editor.openTransient(definition)
  const line = editor.transientDisplayText()?.split("\n").find(row => row.includes("left action") && row.includes("right action"))
  expect(line).toBeDefined()
})

test("transient incompatible arguments deactivate each other", async () => {
  const editor = makeEditor()
  const definition: TransientDefinition = {
    name: "incompatible",
    title: "Incompatible",
    incompatible: [["--all", "--base="]],
    groups: [{
      title: "Arguments",
      infixes: [
        { key: "a", label: "all", argument: "--all" },
        { key: "b", label: "base", argument: "--base=", kind: "value", defaultValue: "" },
        { key: "f", label: "force", argument: "--force" },
      ],
    }],
  }

  editor.openTransient(definition)
  await keySeq(editor, "f")
  await keySeq(editor, "a")
  expect(editor.transient?.values.get("--all")).toBe(true)
  expect(editor.transient?.values.get("--force")).toBe(true)

  const promise = editor.handleKey(parseKey("b"))
  await new Promise(resolve => setTimeout(resolve, 10))
  await editor.handleKey(parseKey("x"))
  await editor.handleKey({ name: "enter", sequence: "\r" })
  await promise

  expect(editor.transient?.values.get("--base=")).toBe("x")
  expect(editor.transient?.values.get("--all")).toBe(false)
  expect(editor.transient?.values.get("--force")).toBe(true)

  await keySeq(editor, "a")
  expect(editor.transient?.values.get("--all")).toBe(true)
  expect(editor.transient?.values.get("--base=")).toBe(false)
  expect(editor.transient?.values.get("--force")).toBe(true)

  await keySeq(editor, "a")
  expect(editor.transient?.values.get("--all")).toBe(false)
  expect(editor.transient?.values.get("--base=")).toBe(false)
  expect(editor.transient?.values.get("--force")).toBe(true)
})

test("transient group titles can be computed on every redisplay", () => {
  const editor = makeEditor()
  let revision = "abc123"
  const definition: TransientDefinition = {
    name: "dynamic-title",
    title: "Rebase",
    groups: [{
      title: () => `Rebase ${revision} onto`,
      suffixes: [{ key: "t", label: "revision", command: "ignore" }],
    }],
  }

  editor.openTransient(definition)
  expect(editor.transientDisplayText()).toContain("Rebase abc123 onto")

  revision = "def456"
  expect(editor.transientDisplayText()).toContain("Rebase def456 onto")
  expect(editor.transientDisplayText()).not.toContain("abc123")
})

test("transient suffix labels can be computed on every redisplay", () => {
  const editor = makeEditor()
  let target = "origin"
  const definition: TransientDefinition = {
    name: "dynamic-label",
    title: "Push",
    groups: [{
      title: "Actions",
      suffixes: [{ key: "p", label: () => `push to ${target}`, command: "ignore" }],
    }],
  }

  editor.openTransient(definition)
  expect(editor.transientDisplayText()).toContain("push to origin")

  target = "upstream"
  expect(editor.transientDisplayText()).toContain("push to upstream")
})

test("transient groups with an empty title render no heading line", () => {
  const editor = makeEditor()
  const definition: TransientDefinition = {
    name: "empty-title",
    title: "Empty Title",
    groups: [{
      title: "",
      subgroups: [
        { title: "Left", suffixes: [{ key: "a", label: "left action", command: "ignore" }] },
        { title: "Right", suffixes: [{ key: "b", label: "right action", command: "ignore" }] },
      ],
    }],
  }

  editor.openTransient(definition)
  const lines = editor.transientDisplayText()?.split("\n") ?? []

  expect(lines[0]).toBe("Empty Title")
  expect(lines[1]).toBe("")
  expect(lines[2]).toContain("Left")
  expect(lines[2]).toContain("Right")
  expect(lines[3]).toContain("left action")
  expect(lines[3]).toContain("right action")
  expect(lines.length).toBe(4)
})

test("transient subgroups with an empty title render no column heading", () => {
  const editor = makeEditor()
  const definition: TransientDefinition = {
    name: "empty-subgroup-title",
    title: "Empty Subgroup",
    groups: [{
      title: "",
      subgroups: [
        { title: "", suffixes: [{ key: "a", label: "left action", command: "ignore" }] },
        { title: "", suffixes: [{ key: "b", label: "right action", command: "ignore" }] },
      ],
    }],
  }

  editor.openTransient(definition)
  const lines = editor.transientDisplayText()?.split("\n") ?? []

  expect(lines[0]).toBe("Empty Subgroup")
  expect(lines[1]).toBe("")
  expect(lines[2]).toContain("left action")
  expect(lines[2]).toContain("right action")
  expect(lines.length).toBe(3)
})

test("transient themed footer highlights key chunks", () => {
  const editor = makeEditor()
  editor.openTransient(demoTransient)

  const model = buildDisplayModel(editor, { viewport: { rows: 12, cols: 80 } })
  if (model.windows.kind !== "leaf") throw new Error("expected leaf")
  const keyChunk = model.windows.pane.footer?.chunks.find(chunk => chunk.text === "a")

  expect(keyChunk?.bold).toBe(true)
  expect(keyChunk?.fg).toBeDefined()
})

/** Text of every span carrying `face` in the active transient. */
function facedText(editor: Editor, face: string): string[] {
  const display = editor.transientDisplay()
  if (!display) return []
  return display.spans
    .filter(span => span.face === face)
    .map(span => display.text.slice(span.start, span.end))
}

test("transient switches face their argument active vs inactive like Emacs", async () => {
  const editor = makeEditor()
  editor.command("demo-act", () => {})
  editor.openTransient(demoTransient)

  // Emacs `transient-format-value` on a `transient-switch`: the argument text is
  // identical either way, only the face changes.
  expect(editor.transientDisplayText()).toContain("extra (--extra)")
  expect(facedText(editor, "transient-inactive-argument")).toContain("--extra")
  expect(facedText(editor, "transient-argument")).not.toContain("--extra")

  await keySeq(editor, "- x")

  expect(editor.transientDisplayText()).toContain("extra (--extra)")
  expect(facedText(editor, "transient-argument")).toContain("--extra")
  expect(facedText(editor, "transient-inactive-argument")).not.toContain("--extra")
})

test("transient options face the argument and its value separately", async () => {
  const editor = makeEditor()
  const definition: TransientDefinition = {
    name: "faced-option",
    title: "Faced Option",
    groups: [{
      title: "Arguments",
      infixes: [
        { key: "b", label: "base", argument: "--base=", kind: "value", style: "equals", prompt: "Base: " },
      ],
    }],
  }

  editor.openTransient(definition)
  // Unset: Emacs shows the bare argument in `transient-inactive-argument`.
  expect(editor.transientDisplayText()).toContain("base (--base=)")
  expect(facedText(editor, "transient-inactive-argument")).toContain("--base=")

  const reading = editor.handleKey(parseKey("b"))
  await new Promise(resolve => setTimeout(resolve, 10))
  await editor.minibufferInsert("main")
  editor.minibufferSubmit()
  await reading

  // Set: argument in `transient-argument`, value in `transient-value`.
  expect(editor.transientDisplayText()).toContain("base (--base=main)")
  expect(facedText(editor, "transient-argument")).toContain("--base=")
  expect(facedText(editor, "transient-value")).toContain("main")
})

test("transient variable infixes render a prin1'd value like transient-lisp-variable", async () => {
  const editor = makeEditor()
  const definition: TransientDefinition = {
    name: "faced-variable",
    title: "Faced Variable",
    groups: [{
      title: "Strategy",
      infixes: [
        { key: "c", label: "CL number to sync", argument: "--cl", kind: "variable", prompt: "CL: " },
      ],
    }],
  }

  editor.openTransient(definition)
  // Emacs `transient-variable` uses " %k %d %v" with no parens, and
  // `transient-lisp-variable` prin1's the value, so unset reads `nil`.
  expect(editor.transientDisplayText()).toContain("CL number to sync nil")
  expect(editor.transientDisplayText()).not.toContain("(--cl)")

  const reading = editor.handleKey(parseKey("c"))
  await new Promise(resolve => setTimeout(resolve, 10))
  await editor.minibufferInsert("12345")
  editor.minibufferSubmit()
  await reading

  expect(editor.transientDisplayText()).toContain("CL number to sync \"12345\"")
  expect(facedText(editor, "transient-value")).toContain("\"12345\"")
})

test("transient keys are unpadded by default and padded only with padKeys", () => {
  const editor = makeEditor()
  const suffixes = [
    { key: "a", label: "short", command: "ignore" },
    { key: "C-c", label: "long", command: "ignore" },
  ]

  // Emacs `pad-keys` defaults to nil, so keys keep their natural width.
  editor.openTransient({ name: "unpadded", title: "Unpadded", groups: [{ title: "G", suffixes }] })
  expect(editor.transientDisplayText()).toContain(" a short")
  expect(editor.transientDisplayText()).toContain(" C-c long")

  editor.openTransient({ name: "padded", title: "Padded", groups: [{ title: "G", padKeys: true, suffixes }] })
  expect(editor.transientDisplayText()).toContain(" a   short")
  expect(editor.transientDisplayText()).toContain(" C-c long")
})
