import { describe, expect, test } from "bun:test"
import { getMode } from "../../src/modes/mode"
import { install } from "../../plugins/magit"
import {
  buildInteractiveRebaseInvocation,
  changeTodoActionAtPoint,
  moveTodoLine,
  parseGitLogForRebaseTodo,
  runInteractiveRebaseTodo,
} from "../../plugins/magit/rebase-todo"
import { makeEditor } from "./helper"

const TODO = [
  "pick aaa1111 first commit",
  "pick bbb2222 second commit",
  "pick ccc3333 third commit",
  "",
].join("\n")

describe("git rebase todo helpers", () => {
  test("changes the action word on the current line", () => {
    const point = TODO.indexOf("bbb2222")
    const next = changeTodoActionAtPoint(TODO, point, "squash")
    expect(next.text).toContain("pick aaa1111 first commit")
    expect(next.text).toContain("squash bbb2222 second commit")
    expect(next.text).toContain("pick ccc3333 third commit")
    expect(next.point).toBe(point + "squash".length - "pick".length)
  })

  test("leaves non-todo lines unchanged", () => {
    const text = "# comment\npick aaa1111 first commit\n"
    expect(changeTodoActionAtPoint(text, 0, "drop")).toEqual({ text, point: 0 })
  })

  test("moves the current line up and down", () => {
    const point = TODO.indexOf("bbb2222")
    const movedUp = moveTodoLine(TODO, point, -1)
    expect(movedUp.text.split("\n").slice(0, 3)).toEqual([
      "pick bbb2222 second commit",
      "pick aaa1111 first commit",
      "pick ccc3333 third commit",
    ])
    expect(movedUp.point).toBe("pick ".length)

    const movedDown = moveTodoLine(TODO, point, 1)
    expect(movedDown.text.split("\n").slice(0, 3)).toEqual([
      "pick aaa1111 first commit",
      "pick ccc3333 third commit",
      "pick bbb2222 second commit",
    ])
  })

  test("parses git log output into pick lines", () => {
    expect(parseGitLogForRebaseTodo("abc1234 subject one\ndef5678 subject two\n")).toBe([
      "pick abc1234 subject one",
      "pick def5678 subject two",
      "",
    ].join("\n"))
  })
})

test("interactive rebase argv and env are built for an injected runner", async () => {
  const writes: Array<{ path: string; text: string }> = []
  const runs: Array<{ args: string[]; cwd: string; env: Record<string, string> }> = []
  const result = await runInteractiveRebaseTodo({
    base: "HEAD~5",
    cwd: "/repo",
    todoText: TODO,
    todoPath: "/tmp/rebase todo's file",
    writeTodoFile: async (path, text) => { writes.push({ path, text }) },
    runner: async (args, cwd, env) => {
      runs.push({ args, cwd, env })
      return { out: "ok\n", err: "", code: 0 }
    },
  })

  expect(writes).toEqual([{ path: "/tmp/rebase todo's file", text: TODO }])
  expect(runs).toHaveLength(1)
  expect(runs[0]!.args).toEqual(["rebase", "-i", "HEAD~5"])
  expect(runs[0]!.cwd).toBe("/repo")
  expect(runs[0]!.env.GIT_SEQUENCE_EDITOR).toBe("cp '/tmp/rebase todo'\\''s file'")
  expect(runs[0]!.env.GIT_EDITOR).toBe("true")
  expect(result.args).toEqual(["rebase", "-i", "HEAD~5"])
  expect(result.env).toEqual(runs[0]!.env)
})

test("buildInteractiveRebaseInvocation returns git rebase -i argv and editor env", () => {
  expect(buildInteractiveRebaseInvocation("main", "/tmp/todo")).toEqual({
    args: ["rebase", "-i", "main"],
    env: {
      GIT_SEQUENCE_EDITOR: "cp '/tmp/todo'",
      GIT_EDITOR: "true",
    },
  })
})

test("magit interactive rebase commands, keymap, and transient are wired", async () => {
  const editor = makeEditor()
  install(editor)

  for (const cmd of [
    "magit-rebase-interactive",
    "git-rebase-pick",
    "git-rebase-reword",
    "git-rebase-edit",
    "git-rebase-squash",
    "git-rebase-fixup",
    "git-rebase-drop",
    "git-rebase-move-line-up",
    "git-rebase-move-line-down",
    "git-rebase-finish",
    "git-rebase-abort",
  ]) {
    expect(editor.commands.get(cmd)).toBeDefined()
  }

  const status = getMode("magit-status")
  expect(status?.keymap?.get("r i")).toBe("magit-rebase-interactive")

  const mode = getMode("git-rebase-mode")
  expect(mode?.keymap?.get("p")).toBe("git-rebase-pick")
  expect(mode?.keymap?.get("r")).toBe("git-rebase-reword")
  expect(mode?.keymap?.get("e")).toBe("git-rebase-edit")
  expect(mode?.keymap?.get("s")).toBe("git-rebase-squash")
  expect(mode?.keymap?.get("f")).toBe("git-rebase-fixup")
  expect(mode?.keymap?.get("k")).toBe("git-rebase-drop")
  expect(mode?.keymap?.get("C-k")).toBe("git-rebase-drop")
  expect(mode?.keymap?.get("M-up")).toBe("git-rebase-move-line-up")
  expect(mode?.keymap?.get("M-down")).toBe("git-rebase-move-line-down")
  expect(mode?.keymap?.get("C-c C-c")).toBe("git-rebase-finish")
  expect(mode?.keymap?.get("C-c C-k")).toBe("git-rebase-abort")

  await editor.run("magit-rebase-popup")
  expect(editor.transient?.definition.name).toBe("magit-rebase")
  expect(editor.transientDisplayText()).toContain(" i interactive")
})
