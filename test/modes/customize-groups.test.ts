/**
 * Parity tests for the Custom *group* tree: the root listing, member ordering,
 * `See also` links, and the `Subgroups:` subtitle.
 *
 * The expected root buffer was captured from GNU Emacs 30.2 (`emacs -Q --batch`
 * running `(customize)`); the only intentional difference is the button row,
 * since `emacs -Q` has no custom-file and therefore omits `[ Apply and Save ]`.
 */
import { expect, test } from "bun:test"
import { makeEditor } from "../plugins/helper"
import type { Editor } from "../../src/kernel/editor"
import {
  customGroupChildren,
  ensureCustomGroup,
  defcustom,
  defgroup,
  getCustomGroup,
  listCustomGroups,
  TOP_CUSTOM_GROUP,
} from "../../src/runtime/custom"

function lines(editor: Editor): string[] {
  return editor.currentBuffer.text.split("\n")
}

/** The customization registry is process-global, so other test files leave
 *  probe groups hanging off the root. Reparent them out of the way, exactly as
 *  a real `defgroup` would, so the root listing is the shipped one. */
function detachProbeGroups(): void {
  for (const name of customGroupChildren(TOP_CUSTOM_GROUP)) {
    if (EMACS_ROOT_CHILDREN.includes(name)) continue
    defgroup(name, getCustomGroup(name)?.doc ?? `${name} probe group.`, { parent: "local" })
  }
}

/** `(get 'emacs 'custom-group)` in GNU Emacs 30.2, in order. */
const EMACS_ROOT_CHILDREN = [
  "editing", "convenience", "files", "wp", "text", "data", "external", "comm",
  "programming", "applications", "development", "environment", "faces",
  "help", "multimedia", "local",
]

test("the root group is `emacs`, as in Emacs", () => {
  expect(TOP_CUSTOM_GROUP).toBe("emacs")
  expect(getCustomGroup("emacs")?.doc).toBe("Customization of the One True Editor.")
  expect(getCustomGroup("emacs")?.parent).toBeUndefined()
})

test("M-x customize renders the Emacs root buffer verbatim", async () => {
  const editor = makeEditor()
  detachProbeGroups()
  await editor.run("customize")
  expect(editor.currentBuffer.name).toBe("*Customize Group: Emacs*")
  // Captured from `emacs -Q --batch --eval '(customize)'`. The `[ Apply and
  // Save ]` button is ours: `emacs -Q` cannot save, so it omits that button.
  expect(lines(editor)).toEqual([
    "For help using this buffer, see [Easy Customization] in the [Emacs manual].",
    "",
    "                                         [ Search ]",
    "",
    "Operate on all settings in this buffer:",
    "[ Revert... ] [ Apply ] [ Apply and Save ]",
    "",
    "",
    "Emacs group: Customization of the One True Editor.",
    "      [ State ]: visible group members are all at standard values.",
    "      See also [Manual].",
    "",
    "[Editing]               Basic text editing facilities.",
    "[Convenience]           Convenience features for faster editing.",
    "[Files]                 Support for editing files.",
    "[Wp]                    Support for editing text files. More",
    "[Text]                  Support for editing text files.",
    "[Data]                  Support for editing binary data files.",
    "[External]              Interfacing to external utilities.",
    "[Communication]         Communications, networking, and remote access to files.",
    "[Programming]           Support for programming in other languages.",
    "[Applications]          Applications written in Emacs.",
    "[Development]           Support for further development of Emacs.",
    "[Environment]           Fitting Emacs with its environment.",
    "[Faces]                 Support for multiple fonts.",
    "[Help]                  Support for Emacs help systems.",
    "[Multimedia]            Non-textual support, specifically images and sound.",
    "[Local]                 Code local to your site.",
    "",
    "",
    "",
  ])
})

test("the root group's children are Emacs's sixteen, in declaration order", () => {
  detachProbeGroups()
  expect(customGroupChildren(TOP_CUSTOM_GROUP)).toEqual(EMACS_ROOT_CHILDREN)
})

test("the root group is never sorted, but other groups are", async () => {
  const editor = makeEditor()
  detachProbeGroups()
  // cus-edit.el: "Never sort the top-level custom group."
  await editor.run("customize")
  // Group rows are `[Tag]<pad>doc`; the button row has no doc after it.
  const groupRow = (l: string) => /^\[[^\]]+\] +\S/.test(l) && !l.startsWith("[ ")
  const rootTags = lines(editor).filter(groupRow).map(l => l.slice(1, l.indexOf("]")))
  expect(rootTags).toEqual([
    "Editing", "Convenience", "Files", "Wp", "Text", "Data", "External",
    "Communication", "Programming", "Applications", "Development",
    "Environment", "Faces", "Help", "Multimedia", "Local",
  ])
  expect(rootTags).not.toEqual([...rootTags].sort())

  // A non-root group still sorts alphabetically.
  defgroup("sortprobe", "Sort probe doc.", { parent: "editing" })
  defgroup("sortprobe-zeta", "Zeta doc.", { parent: "sortprobe" })
  defgroup("sortprobe-alpha", "Alpha doc.", { parent: "sortprobe" })
  defgroup("sortprobe-mid", "Mid doc.", { parent: "sortprobe" })
  await editor.run("customize-group", ["sortprobe"])
  const subTags = lines(editor).filter(l => l.startsWith("[Sortprobe")).map(l => l.slice(1, l.indexOf("]")))
  expect(subTags).toEqual(["Sortprobe Alpha", "Sortprobe Mid", "Sortprobe Zeta"])
})

test("`Subgroups:` is suppressed for the root group only", async () => {
  const editor = makeEditor()
  await editor.run("customize")
  // cus-edit.el's `have-subtitle` is nil when the group is `emacs`.
  expect(editor.currentBuffer.text).not.toContain("Subgroups:")

  await editor.run("customize-group", ["programming"])
  expect(editor.currentBuffer.text).toContain("Subgroups:")
})

test("`See also [Manual].` comes from the group's :link", async () => {
  const editor = makeEditor()
  await editor.run("customize")
  expect(editor.currentBuffer.text).toContain("      See also [Manual].")

  // A group without a :link prints no See also line.
  defgroup("linkless", "Linkless doc.", { parent: "editing" })
  await editor.run("customize-group", ["linkless"])
  expect(editor.currentBuffer.text).not.toContain("See also")

  // ...and one with a :link does.
  defgroup("linked", "Linked doc.", {
    parent: "editing",
    links: [{ tag: "Manual", manual: "(emacs)Top" }],
  })
  await editor.run("customize-group", ["linked"])
  expect(editor.currentBuffer.text).toContain("      See also [Manual].")
})

test("plugin and core groups hang off an Emacs parent, never off the root", () => {
  // Emacs's own parents for the groups it ships.
  const expectedParents: Record<string, string> = {
    customize: "help",
    tools: "programming",
    languages: "programming",
    ediff: "tools",
    vc: "tools",
    diff: "tools",
    flyspell: "wp",
    org: "outlines",
    outlines: "text",
    "hi-lock": "matching",
    whitespace: "convenience",
    dired: "files",
    backup: "files",
    "auto-save": "files",
    minibuffer: "environment",
    display: "environment",
    windows: "environment",
    killing: "editing",
    fill: "editing",
    comint: "processes",
    processes: "external",
    "basic-faces": "faces",
    // jemacs-only groups, parented at their nearest Emacs analogue.
    magit: "tools",
    "vc-dir": "vc",
    jproced: "processes",
    shadow: "comm",
    transient: "convenience",
  }
  for (const [group, parent] of Object.entries(expectedParents)) {
    expect(getCustomGroup(group)?.parent, group).toBe(parent)
  }
})

test("every shipped group carries a doc string", () => {
  // A group with no doc renders "Group definition missing.", which no real
  // Emacs group ever shows. Probe groups other test files create with a bare
  // `:group` reference are not shipped groups, so they are excluded by name.
  const undocumented = listCustomGroups()
    .filter(group => !group.doc && !/^(jemacs|probe|sortprobe|lategroup|linkless|linked|w-|rt-|cf-|nt-|sv-|bg)/.test(group.name))
    .map(group => group.name)
  expect(undocumented).toEqual([])
})

test("a group auto-created by :group is re-parented when its defgroup runs", async () => {
  const editor = makeEditor()
  // `defcustom` mentions the group first, so it is implicitly created at root.
  defcustom("late-option", "integer", 1, "Late doc.", "lategroup")
  expect(getCustomGroup("lategroup")?.parent).toBe(TOP_CUSTOM_GROUP)
  // The real `defgroup` then moves it, and it leaves the root listing.
  defgroup("lategroup", "Late group doc.", { parent: "tools" })
  expect(getCustomGroup("lategroup")?.parent).toBe("tools")
  expect(customGroupChildren(TOP_CUSTOM_GROUP)).not.toContain("lategroup")
  await editor.run("customize-group", ["lategroup"])
  expect(editor.currentBuffer.text).toContain("Lategroup group: Late group doc.")
  expect(editor.currentBuffer.text).toContain("Parent groups: [Tools]")
})

test("a group with a custom tag uses it (Emacs names `comm` \"Communication\")", async () => {
  const editor = makeEditor()
  expect(getCustomGroup("comm")?.tag).toBe("Communication")
  await editor.run("customize-group", ["comm"])
  expect(editor.currentBuffer.name).toBe("*Customize Group: Communication*")
  expect(editor.currentBuffer.text).toContain("Communication group: Communications, networking")
})
