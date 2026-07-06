import { expect, test } from "bun:test"
import { buildDisplayModel } from "../../src/display/build-display-model"
import type { TransientDefinition } from "../../src/kernel/editor"
import { makeEditor } from "./helper"

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
  expect(editor.transientDisplayText()).toContain("[ ] extra")
  expect(editor.minibufferCompletionDisplay).toBeNull()

  expect((await editor.handleKey({ name: "-", sequence: "-" })).status).toBe("pending")
  expect((await editor.handleKey({ name: "x", sequence: "x" })).status).toBe("command")
  expect(editor.transientDisplayText()).toContain("[*] extra")

  const result = await editor.handleKey({ name: "a", sequence: "a" })
  expect(result.status).toBe("command")
  expect(result.status === "command" && result.command).toBe("demo-act")
  expect(seen).toEqual(["--extra"])
  expect(editor.transient).toBeNull()
  expect(editor.transientDisplayText()).toBeNull()
  expect(editor.minibufferCompletionDisplay).toBeNull()
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
