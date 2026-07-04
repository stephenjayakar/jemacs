import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeEditor } from "./helper"
import { keySeq } from "../harness"
import { setPlatformRuntime } from "../../src/platform/runtime"
import type { SpawnHandle, SpawnOptions } from "../../src/platform/runtime"
import { setCustom } from "../../src/runtime/custom"
import {
  install,
  orgParseHeadlines,
  orgHeadlineAtPoint,
  orgSubtreeEndLine,
  orgChildren,
  orgFormatTimestamp,
  orgParseDateInput,
  orgShiftTimestampText,
  orgSetPlanningLineText,
  orgScanAgenda,
  orgAgendaTargetForLine,
  orgFontLock,
  orgVisibleSpans,
  orgDisplayFilter,
  orgBabelBuildInvocation,
  orgBabelReplaceResultsText,
  orgSrcBlockAtPoint,
  orgToHtml,
  orgToAscii,
  ORG_FOLDED_LOCAL,
  type FoldRange,
} from "../../plugins/org"
import { getMode } from "../../src/modes/mode"

const DOC = [
  "* Top",            // 0
  "body a",           // 1
  "** TODO Child A",  // 2
  "a1",               // 3
  "*** Grand",        // 4
  "g1",               // 5
  "** DONE Child B",  // 6
  "b1",               // 7
  "* Second",         // 8
  "",                 // 9 (trailing newline → empty line)
].join("\n")

function setup(text: string, point = 0) {
  const editor = makeEditor()
  install(editor)
  const buffer = editor.scratch("test.org", text, "org-mode")
  buffer.point = point
  return { editor, buffer }
}

function folded(buffer: ReturnType<typeof setup>["buffer"]): FoldRange[] {
  return (buffer.locals.get(ORG_FOLDED_LOCAL) as FoldRange[] | undefined) ?? []
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(enc.encode(text))
      ctrl.close()
    },
  })
}

function fakeSpawn(stdout: string, stderr = "", code = 0) {
  const calls: SpawnOptions[] = []
  const stdin: string[] = []
  const spawn = (opts: SpawnOptions): SpawnHandle => {
    calls.push(opts)
    return {
      stdin: opts.stdin === "pipe" ? { write: chunk => stdin.push(chunk), end: () => {} } : null,
      stdout: streamOf(stdout),
      stderr: streamOf(stderr),
      exited: Promise.resolve(code),
      kill: () => {},
    }
  }
  return { spawn, calls, stdin }
}

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  setCustom("org-agenda-files", [])
  setCustom("org-archive-location", "%s_archive::")
  setCustom("org-capture-templates", [])
})

describe("orgParseHeadlines", () => {
  test("parses level, keyword, title and offsets", () => {
    const hs = orgParseHeadlines(DOC)
    expect(hs.map(h => [h.line, h.level, h.keyword, h.title])).toEqual([
      [0, 1, null, "Top"],
      [2, 2, "TODO", "Child A"],
      [4, 3, null, "Grand"],
      [6, 2, "DONE", "Child B"],
      [8, 1, null, "Second"],
    ])
    expect(DOC.slice(hs[1]!.start, hs[1]!.end)).toBe("** TODO Child A")
  })

  test("ignores body lines and indented stars", () => {
    const hs = orgParseHeadlines("plain\n * not a heading\n*real\n* yes\n")
    // "*real" has no space after the stars; " * not" has leading space.
    expect(hs.map(h => h.title)).toEqual(["yes"])
  })

  test("orgHeadlineAtPoint resolves point inside the headline line, null elsewhere", () => {
    expect(orgHeadlineAtPoint(DOC, DOC.indexOf("Child A"))?.title).toBe("Child A")
    expect(orgHeadlineAtPoint(DOC, DOC.indexOf("body a"))).toBeNull()
  })

  test("subtree extent and direct children", () => {
    const hs = orgParseHeadlines(DOC)
    const lc = DOC.split("\n").length
    const top = hs[0]!
    expect(orgSubtreeEndLine(hs, top, lc)).toBe(7)
    expect(orgChildren(hs, top, lc).map(c => c.title)).toEqual(["Child A", "Child B"])
    expect(orgSubtreeEndLine(hs, hs[1]!, lc)).toBe(5) // Child A subtree ends before Child B
  })
})

describe("org babel source blocks", () => {
  const SRC = [
    "* Code",
    "#+BEGIN_SRC python -n",
    "print(1)",
    "#+END_SRC",
    "",
  ].join("\n")

  test("orgSrcBlockAtPoint parses case-insensitive blocks, language, switches, and body range", () => {
    const block = orgSrcBlockAtPoint(SRC, SRC.indexOf("print"))!
    expect(block).toMatchObject({ openLine: 1, closeLine: 3, lang: "python", switches: "-n" })
    expect(SRC.slice(block.bodyStart, block.bodyEnd)).toBe("print(1)\n")
    expect(orgSrcBlockAtPoint(SRC, SRC.indexOf("* Code"))).toBeNull()
  })

  test("orgBabelBuildInvocation maps languages to interpreter argv", () => {
    const alist: Array<[string, string]> = [
      ["python", "python3"],
      ["bash", "bash"],
      ["js", "node"],
      ["ruby", "ruby"],
      ["lua", "lua"],
    ]
    expect(orgBabelBuildInvocation("python", "print(1)", alist)).toEqual({ cmd: ["python3", "-"], stdin: "print(1)" })
    expect(orgBabelBuildInvocation("bash", "echo ok", alist)).toEqual({ cmd: ["bash", "-s"], stdin: "echo ok" })
    expect(orgBabelBuildInvocation("js", "console.log(1)", alist)).toEqual({ cmd: ["node"], stdin: "console.log(1)" })
    expect(orgBabelBuildInvocation("ruby", "puts 1", alist)).toEqual({ cmd: ["ruby"], stdin: "puts 1" })
    expect(orgBabelBuildInvocation("lua", "print(1)", alist)).toEqual({ cmd: ["lua"], stdin: "print(1)" })
    expect(orgBabelBuildInvocation("unknown", "", alist)).toBeNull()
  })

  test("result replacement inserts fresh plain results and replaces stale ones", () => {
    const block = orgSrcBlockAtPoint(SRC, SRC.indexOf("print"))!
    expect(orgBabelReplaceResultsText(SRC, block, "1\n").text).toBe([
      "* Code",
      "#+BEGIN_SRC python -n",
      "print(1)",
      "#+END_SRC",
      "#+RESULTS:",
      ": 1",
      "",
    ].join("\n"))

    const stale = [
      "* Code",
      "#+begin_src sh",
      "echo new",
      "#+end_src",
      "#+RESULTS:",
      ": old",
      ": output",
      "",
      "* Next",
      "",
    ].join("\n")
    const staleBlock = orgSrcBlockAtPoint(stale, stale.indexOf("echo"))!
    expect(orgBabelReplaceResultsText(stale, staleBlock, "new\n").text).toBe([
      "* Code",
      "#+begin_src sh",
      "echo new",
      "#+end_src",
      "#+RESULTS:",
      ": new",
      "",
      "* Next",
      "",
    ].join("\n"))
  })

  test("org-babel-execute-src-block uses injected spawn and inserts results", async () => {
    const editor = makeEditor()
    const { spawn, calls, stdin } = fakeSpawn("2\n")
    install(editor, { spawn })
    const buffer = editor.scratch("test.org", SRC, "org-mode")
    buffer.point = SRC.indexOf("print")

    await editor.run("org-babel-execute-src-block")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.cmd).toEqual(["python3", "-"])
    expect(calls[0]?.stdin).toBe("pipe")
    expect(stdin).toEqual(["print(1)\n"])
    expect(buffer.text).toContain("#+RESULTS:\n: 2\n")
  })

  test("C-c C-c dispatch executes source blocks before table or checkbox DWIM", async () => {
    const editor = makeEditor()
    const { spawn } = fakeSpawn("ok\n")
    install(editor, { spawn })
    const buffer = editor.scratch("test.org", "#+begin_src sh\necho ok\n#+end_src\n", "org-mode")
    buffer.point = buffer.text.indexOf("echo")

    await keySeq(editor, "C-c", "C-c")

    expect(buffer.text).toBe("#+begin_src sh\necho ok\n#+end_src\n#+RESULTS:\n: ok\n")
  })

  test("org-edit-special commit replaces the source block body", async () => {
    const { editor, buffer: source } = setup(SRC, SRC.indexOf("print"))

    await editor.run("org-edit-special")
    const edit = editor.currentBuffer
    expect(edit.name).toBe("*Org Src python*")
    expect(edit.text).toBe("print(1)\n")

    edit.setText("print(2)")
    await editor.run("edit-indirect-commit")
    expect(source.text).toBe("* Code\n#+BEGIN_SRC python -n\nprint(2)\n#+END_SRC\n")
    expect(editor.currentBuffer).toBe(source)
  })

  test("org-edit-special abort leaves the source block body unchanged", async () => {
    const { editor, buffer: source } = setup(SRC, SRC.indexOf("print"))

    await editor.run("org-edit-special")
    editor.currentBuffer.setText("print(9)")
    await editor.run("edit-indirect-abort")

    expect(source.text).toBe(SRC)
    expect(editor.currentBuffer).toBe(source)
  })

  test("org-babel-tangle writes blocks with :tangle targets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jemacs-org-tangle-"))
    tempDirs.push(dir)
    const text = [
      "#+begin_src sh :tangle a.sh",
      "echo one",
      "#+end_src",
      "#+begin_src sh :tangle a.sh",
      "echo two",
      "#+end_src",
      "#+begin_src js :tangle b.js",
      "console.log(1)",
      "#+end_src",
      "",
    ].join("\n")
    const { editor, buffer } = setup(text, 0)
    buffer.path = join(dir, "notes.org")

    await editor.run("org-babel-tangle")

    expect(await readFile(join(dir, "a.sh"), "utf8")).toBe("echo one\n\necho two\n")
    expect(await readFile(join(dir, "b.js"), "utf8")).toBe("console.log(1)\n")
  })
})

describe("org archive, refile, and capture", () => {
  test("org-archive-subtree cuts the subtree and appends to the archive file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jemacs-org-archive-"))
    tempDirs.push(dir)
    const file = join(dir, "tasks.org")
    const { editor, buffer } = setup("* Keep\n* Archive\nbody\n** Child\n", "* Keep\n".length)
    buffer.path = file

    await keySeq(editor, "C-c", "$")

    expect(buffer.text).toBe("* Keep\n")
    expect(await readFile(`${file}_archive`, "utf8")).toBe("* Archive\nbody\n** Child\n")
  })

  test("org-refile moves the current subtree as a child of the selected heading", async () => {
    const text = "* Target\nbody\n* Move\n** Child\n* Other\n"
    const { editor, buffer } = setup(text, text.indexOf("* Move"))
    editor.completingRead = (_prompt, opts) => {
      expect(opts.collection).toContain("1: * Target")
      return Promise.resolve("1: * Target")
    }

    await keySeq(editor, "C-c", "C-w")

    expect(buffer.text).toBe("* Target\nbody\n** Move\n*** Child\n* Other\n")
    expect(buffer.point).toBe(buffer.text.indexOf("** Move"))
  })

  test("org-capture expands a selected template, appends it, and opens at %?", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jemacs-org-capture-"))
    tempDirs.push(dir)
    const file = join(dir, "capture.org")
    await writeFile(file, "Existing\n")
    const editor = makeEditor()
    install(editor)
    setCustom("org-capture-templates", [["t", "Task", file, "* TODO %?\nCaptured %U"]])
    editor.completingRead = (_prompt, opts) => Promise.resolve(opts.collection?.[0] ?? null)

    await editor.run("org-capture")

    expect(editor.currentBuffer.path).toBe(file)
    expect(editor.currentBuffer.text).toContain("Existing\n* TODO \nCaptured [")
    expect(editor.currentBuffer.point).toBe(editor.currentBuffer.text.indexOf("* TODO ") + "* TODO ".length)
  })
})

describe("org export", () => {
  const EXPORT_DOC = [
    "#+TITLE: Demo <Doc>",
    "* TODO Heading *bold*",
    "Paragraph /italic/ _under_ ~code~ =verbatim= [[https://example.com?a=1&b=2][Example <site>]] [[mailto:a@example.com]].",
    "",
    "- [X] done",
    "+ [ ] todo",
    "1. first",
    "2. second",
    "",
    "| Name | Value |",
    "|------+-------|",
    "| <x> | a & b |",
    "",
    "#+begin_src js",
    "console.log(\"<ok>\")",
    "#+end_src",
    "#+RESULTS:",
    ": <ok>",
    ": a & b",
    "",
  ].join("\n")

  test("orgToHtml covers headings, inline markup, links, lists, tables, blocks, results, title, and escaping", () => {
    const html = orgToHtml(EXPORT_DOC)

    expect(html).toContain("<title>Demo &lt;Doc&gt;</title>")
    expect(html).toContain("<h1 class=\"title\">Demo &lt;Doc&gt;</h1>")
    expect(html).toContain("<h1><span class=\"todo todo\">TODO</span> Heading <strong>bold</strong></h1>")
    expect(html).toContain("<em>italic</em>")
    expect(html).toContain("<span class=\"underline\">under</span>")
    expect(html).toContain("<code>code</code>")
    expect(html).toContain("<code class=\"verbatim\">verbatim</code>")
    expect(html).toContain("<a href=\"https://example.com?a=1&amp;b=2\">Example &lt;site&gt;</a>")
    expect(html).toContain("<a href=\"mailto:a@example.com\">mailto:a@example.com</a>")
    expect(html).toContain("<ul>\n  <li><input type=\"checkbox\" disabled checked> done</li>")
    expect(html).toContain("<li><input type=\"checkbox\" disabled> todo</li>")
    expect(html).toContain("<ol>\n  <li>first</li>\n  <li>second</li>\n</ol>")
    expect(html).toContain("<table>\n  <tr><td>Name</td><td>Value</td></tr>\n  <tr><td>&lt;x&gt;</td><td>a &amp; b</td></tr>\n</table>")
    expect(html).toContain("<pre><code class=\"language-js\">console.log(&quot;&lt;ok&gt;&quot;)</code></pre>")
    expect(html).toContain("<pre>&lt;ok&gt;\na &amp; b</pre>")
  })

  test("orgToAscii strips inline markup, renders links, underlines top headings, and passes tables through", () => {
    const ascii = orgToAscii([
      "* Top *bold*",
      "** Child /em/",
      "*** Grand _under_",
      "See [[https://example.com][Example]] and [[mailto:a@example.com]].",
      "| *A* | B |",
    ].join("\n"))

    expect(ascii).toBe([
      "Top bold",
      "========",
      "Child em",
      "--------",
      "Grand under",
      "See Example (https://example.com) and mailto:a@example.com.",
      "| *A* | B |",
    ].join("\n"))
  })

  test("org export commands write expected filenames and content through injected deps", async () => {
    const editor = makeEditor()
    const writes: Array<{ path: string; text: string }> = []
    install(editor, { writeFile: async (path, text) => { writes.push({ path, text }) } })
    const buffer = editor.scratch("doc.org", "#+TITLE: T\n* H\nBody", "org-mode")
    buffer.path = "/tmp/doc.org"

    await editor.run("org-html-export-to-html")
    await editor.run("org-ascii-export-to-ascii")

    expect(writes[0]).toEqual({ path: "/tmp/doc.html", text: orgToHtml(buffer.text) })
    expect(writes[1]).toEqual({ path: "/tmp/doc.txt", text: orgToAscii(buffer.text) })
  })

  test("org-export-dispatch writes, opens, and creates ascii buffer through injected deps", async () => {
    const editor = makeEditor()
    const writes: Array<{ path: string; text: string }> = []
    const opened: Array<{ target: string; opts?: { allowFile?: boolean } }> = []
    install(editor, {
      writeFile: async (path, text) => { writes.push({ path, text }) },
      openExternal: (target, opts) => { opened.push({ target, opts }) },
    })
    const buffer = editor.scratch("note.org", "* Title\nBody", "org-mode")
    buffer.path = "/tmp/note.org"
    editor.completingReadFunction = async () => "html open"

    await keySeq(editor, "C-c", "C-e")

    expect(writes).toEqual([{ path: "/tmp/note.html", text: orgToHtml(buffer.text) }])
    expect(opened).toEqual([{ target: "file:///tmp/note.html", opts: { allowFile: true } }])

    editor.currentBufferId = buffer.id
    editor.completingReadFunction = async () => "ascii buffer"
    await editor.run("org-export-dispatch")

    expect(editor.currentBuffer.name).toBe("*Org ASCII Export*")
    expect(editor.currentBuffer.text).toBe(orgToAscii(buffer.text))
  })
})

describe("org-cycle (TAB)", () => {
  test("subtree → folded hides everything under the heading", async () => {
    const { editor, buffer } = setup(DOC, 0)
    await editor.run("org-cycle")
    expect(folded(buffer)).toEqual([[1, 7]])
  })

  test("folded → children shows direct children, folds grandchildren", async () => {
    const { editor, buffer } = setup(DOC, 0)
    await editor.run("org-cycle") // → folded
    await editor.run("org-cycle") // → children
    // body line 1 visible; Child A subtree body (3..5) and Child B body (7) folded
    expect(folded(buffer)).toEqual([[3, 5], [7, 7]])
  })

  test("children → subtree clears all folds under the heading", async () => {
    const { editor, buffer } = setup(DOC, 0)
    await editor.run("org-cycle")
    await editor.run("org-cycle")
    await editor.run("org-cycle") // → subtree
    expect(folded(buffer)).toEqual([])
  })

  test("cycling one heading does not disturb a sibling's fold state", async () => {
    const { editor, buffer } = setup(DOC, DOC.indexOf("* Second"))
    buffer.locals.set(ORG_FOLDED_LOCAL, [[1, 7]] as FoldRange[])
    await editor.run("org-cycle") // Second has only trailing blank line
    // Top's fold preserved
    expect(folded(buffer).some(([a]) => a === 1)).toBe(true)
  })

  test("TAB on a body line reports and changes nothing", async () => {
    const { editor, buffer } = setup(DOC, DOC.indexOf("body a"))
    let msg = ""
    editor.events.on("message", ({ text }) => { msg = text })
    await editor.run("org-cycle")
    expect(msg).toContain("Not at a heading")
    expect(folded(buffer)).toEqual([])
  })

  test("orgVisibleSpans maps folded line ranges to character offsets", async () => {
    const { editor, buffer } = setup(DOC, 0)
    await editor.run("org-cycle") // fold lines 1..7
    const spans = orgVisibleSpans(buffer)
    expect(spans.length).toBe(1)
    const [{ start, end }] = spans
    // hidden text begins at the newline after "* Top" and ends at end of "b1"
    expect(DOC.slice(start, end)).toBe("\nbody a\n** TODO Child A\na1\n*** Grand\ng1\n** DONE Child B\nb1")
  })

  test("orgDisplayFilter collapses folded lines and remaps offsets", async () => {
    const { editor, buffer } = setup(DOC, 0)
    expect(orgDisplayFilter(buffer)).toBeNull() // identity when nothing folded
    await editor.run("org-cycle") // fold 1..7
    const filt = orgDisplayFilter(buffer)!
    expect(filt.text).toBe("* Top...\n* Second\n")
    expect(filt.map(DOC.indexOf("Top"))).toBe(filt.text.indexOf("Top"))
    expect(filt.map(DOC.indexOf("* Second"))).toBe(filt.text.indexOf("* Second"))
    // Hidden offsets clamp to the headline's end (where the ellipsis sits).
    expect(filt.map(DOC.indexOf("Child A"))).toBe("* Top".length)
    expect(filt.map(DOC.indexOf("b1"))).toBe("* Top".length)
  })

  test("displayFilter is registered on org-mode", () => {
    setup(DOC)
    expect(getMode("org-mode")?.displayFilter).toBe(orgDisplayFilter)
  })

  test("TAB key dispatches org-cycle through the major-mode keymap", async () => {
    const { editor, buffer } = setup(DOC, 0)
    await keySeq(editor, "TAB")
    expect(folded(buffer)).toEqual([[1, 7]])
  })
})

describe("org-todo (C-c C-t)", () => {
  test("none → TODO → DONE → none", async () => {
    const { editor, buffer } = setup("* Heading\n", 0)
    await editor.run("org-todo")
    expect(buffer.text).toBe("* TODO Heading\n")
    await editor.run("org-todo")
    expect(buffer.text).toBe("* DONE Heading\n")
    await editor.run("org-todo")
    expect(buffer.text).toBe("* Heading\n")
  })

  test("preserves stars at deeper levels", async () => {
    const { editor, buffer } = setup("*** TODO deep\n", 2)
    await editor.run("org-todo")
    expect(buffer.text).toBe("*** DONE deep\n")
  })

  test("C-c C-t dispatches via the mode keymap", async () => {
    const { editor, buffer } = setup("* x\n", 0)
    await keySeq(editor, "C-c", "C-t")
    expect(buffer.text).toBe("* TODO x\n")
  })

  test("no-op on a body line", async () => {
    const { editor, buffer } = setup("* h\nbody\n", 4)
    await editor.run("org-todo")
    expect(buffer.text).toBe("* h\nbody\n")
  })
})

describe("org timestamps", () => {
  test("formats active and inactive timestamps with computed day names", () => {
    const date = orgParseDateInput("2026-07-04")!
    expect(orgFormatTimestamp(date, true)).toBe("<2026-07-04 Sat>")
    expect(orgFormatTimestamp(date, false)).toBe("[2026-07-04 Sat]")
    expect(orgParseDateInput("", new Date(2026, 6, 5))?.getDay()).toBe(0)
    expect(orgParseDateInput("2026-02-31")).toBeNull()
  })

  test("org-time-stamp and org-time-stamp-inactive insert prompted dates", async () => {
    const { editor, buffer } = setup("")

    await editor.run("org-time-stamp", ["2026-07-04"])
    buffer.insert(" ")
    await editor.run("org-time-stamp-inactive", ["2026-07-05"])

    expect(buffer.text).toBe("<2026-07-04 Sat> [2026-07-05 Sun]")
  })

  test("shifts timestamps by one day preserving active/inactive delimiters", () => {
    const shifted = orgShiftTimestampText("a <2026-07-04 Sat> b", 5, 1)
    expect(shifted.text).toBe("a <2026-07-05 Sun> b")
    expect(orgShiftTimestampText("a [2026-07-05 Sun] b", 5, -1).text).toBe("a [2026-07-04 Sat] b")
    expect(orgShiftTimestampText("no timestamp", 0, 1).changed).toBe(false)
  })

  test("S-left/S-right shift timestamps but fall back to heading promote/demote", async () => {
    const { editor, buffer } = setup("* A\n<2026-07-04 Sat>\n", "* A\n".length + 2)

    await keySeq(editor, "S-right")
    expect(buffer.text).toBe("* A\n<2026-07-05 Sun>\n")
    await keySeq(editor, "S-left")
    expect(buffer.text).toBe("* A\n<2026-07-04 Sat>\n")

    buffer.point = 0
    await keySeq(editor, "S-right")
    expect(buffer.text).toBe("** A\n<2026-07-04 Sat>\n")
  })
})

describe("org scheduling and deadlines", () => {
  test("pure helper inserts and replaces planning lines under current heading", () => {
    const inserted = orgSetPlanningLineText("* Task\nbody\n", 0, "SCHEDULED", "<2026-07-04 Sat>")
    expect(inserted.text).toBe("* Task\nSCHEDULED: <2026-07-04 Sat>\nbody\n")

    const replaced = orgSetPlanningLineText(inserted.text, 0, "SCHEDULED", "<2026-07-05 Sun>")
    expect(replaced.text).toBe("* Task\nSCHEDULED: <2026-07-05 Sun>\nbody\n")
  })

  test("org-schedule and org-deadline commands insert/update planning lines", async () => {
    const { editor, buffer } = setup("* Task\nbody\n", 0)

    await editor.run("org-schedule", ["2026-07-04"])
    expect(buffer.text).toBe("* Task\nSCHEDULED: <2026-07-04 Sat>\nbody\n")

    await editor.run("org-deadline", ["2026-07-05"])
    expect(buffer.text).toBe("* Task\nDEADLINE: <2026-07-05 Sun>\nSCHEDULED: <2026-07-04 Sat>\nbody\n")

    await editor.run("org-schedule", ["2026-07-06"])
    expect(buffer.text).toBe("* Task\nDEADLINE: <2026-07-05 Sun>\nSCHEDULED: <2026-07-06 Mon>\nbody\n")
  })

  test("C-c C-s and C-c C-d dispatch via org-mode keymap", async () => {
    const { editor, buffer } = setup("* Task\n", 0)
    const answers = ["2026-07-04", "2026-07-05"]
    editor.prompt = async () => answers.shift() ?? null

    await keySeq(editor, "C-c", "C-s")
    await keySeq(editor, "C-c", "C-d")

    expect(buffer.text).toContain("SCHEDULED: <2026-07-04 Sat>")
    expect(buffer.text).toContain("DEADLINE: <2026-07-05 Sun>")
  })
})

describe("org agenda", () => {
  test("scanner groups overdue, today, upcoming, and all TODOs from fixture strings", () => {
    const agenda = orgScanAgenda([{
      file: "/tmp/a.org",
      text: [
        "* TODO Overdue",
        "SCHEDULED: <2026-07-03 Fri>",
        "* TODO Today",
        "DEADLINE: <2026-07-04 Sat>",
        "* TODO Soon",
        "SCHEDULED: <2026-07-08 Wed>",
        "* TODO Later",
        "SCHEDULED: <2026-07-20 Mon>",
        "* DONE Done",
        "SCHEDULED: <2026-07-04 Sat>",
        "",
      ].join("\n"),
    }], new Date(2026, 6, 4))

    expect(agenda.overdue.map(item => item.heading)).toEqual(["Overdue"])
    expect(agenda.today.map(item => item.heading)).toEqual(["Today", "Done"])
    expect(agenda.upcoming.map(item => item.heading)).toEqual(["Soon"])
    expect(agenda.todos.map(item => item.heading)).toEqual(["Overdue", "Today", "Soon", "Later"])
  })

  test("RET target resolution uses stored agenda file and line", () => {
    const targets = [null, { file: "/tmp/a.org", line: 3 }, null]
    expect(orgAgendaTargetForLine(targets, 2)).toEqual({ file: "/tmp/a.org", line: 3 })
    expect(orgAgendaTargetForLine(targets, 1)).toBeNull()
  })

  test("org-agenda scans configured files and RET jumps to the heading", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jemacs-org-agenda-"))
    tempDirs.push(dir)
    const nested = join(dir, "notes")
    await mkdir(nested)
    const file = join(nested, "tasks.org")
    await writeFile(file, "* TODO Soon\nSCHEDULED: <2026-07-04 Sat>\n")

    const editor = makeEditor()
    install(editor)
    setCustom("org-agenda-files", dir)

    await editor.run("org-agenda")
    const agenda = editor.currentBuffer
    expect(agenda.name).toBe("*Org Agenda*")
    expect(agenda.text).toContain("tasks.org:1: TODO Soon")

    agenda.point = agenda.text.indexOf("tasks.org")
    await keySeq(editor, "RET")

    expect(editor.currentBuffer.path).toBe(file)
    expect(editor.currentBuffer.point).toBe(0)
  })
})

describe("org-meta-return (M-RET)", () => {
  test("inserts a sibling after the current subtree", async () => {
    const { editor, buffer } = setup(DOC, DOC.indexOf("** TODO Child A"))
    await editor.run("org-meta-return")
    // New "** " sibling goes after Child A's subtree (after line 5), before Child B.
    expect(buffer.text).toContain("g1\n** \n** DONE Child B")
    expect(buffer.text[buffer.point - 1]).toBe(" ")
    expect(buffer.text.slice(buffer.point - 3, buffer.point)).toBe("** ")
  })

  test("from body text uses the enclosing heading's level", async () => {
    const { editor, buffer } = setup("* A\nbody\n", 5)
    await editor.run("org-meta-return")
    expect(buffer.text).toBe("* A\nbody\n* \n")
  })

  test("in an empty buffer inserts a level-1 heading", async () => {
    const { editor, buffer } = setup("", 0)
    await editor.run("org-meta-return")
    expect(buffer.text).toBe("* \n")
    expect(buffer.point).toBe(2)
  })

  test("registers org-insert-heading and org-insert-todo-heading command names", async () => {
    const { editor, buffer } = setup("* A\n", 0)

    await editor.run("org-insert-heading")
    expect(buffer.text).toBe("* A\n* \n")

    buffer.point = 0
    await editor.run("org-insert-todo-heading")
    expect(buffer.text).toBe("* A\n* TODO \n* \n")
  })
})

describe("org subtree movement", () => {
  test("moves subtrees up and down across same-level siblings", async () => {
    const text = [
      "* Top",
      "** One",
      "one body",
      "** Two",
      "*** Two child",
      "** Three",
      "",
    ].join("\n")
    const { editor, buffer } = setup(text, text.indexOf("** Two"))

    await editor.run("org-move-subtree-up")
    expect(buffer.text).toBe([
      "* Top",
      "** Two",
      "*** Two child",
      "** One",
      "one body",
      "** Three",
      "",
    ].join("\n"))

    await editor.run("org-move-subtree-down")
    expect(buffer.text).toBe(text)
  })

  test("M-up and M-down dispatch through org-mode keymap", async () => {
    const text = "* A\n* B\n"
    const { editor, buffer } = setup(text, text.indexOf("* B"))

    await keySeq(editor, "M-up")
    expect(buffer.text).toBe("* B\n* A\n")
    await keySeq(editor, "M-down")
    expect(buffer.text).toBe(text)
  })
})

describe("org tags and priority", () => {
  test("org-set-tags-command sets and replaces headline tags", async () => {
    const { editor, buffer } = setup("* TODO Task :old:\n", 0)
    const answers = [":work:home:", ""]
    editor.prompt = async () => answers.shift() ?? null

    await keySeq(editor, "C-c", "C-q")
    expect(buffer.text).toBe("* TODO Task :work:home:\n")

    await editor.run("org-set-tags-command")
    expect(buffer.text).toBe("* TODO Task\n")
  })

  test("org-priority inserts after TODO and clears with space", async () => {
    const { editor, buffer } = setup("* TODO Task\n* Plain\n", 0)
    const answers = ["A", " "]
    editor.prompt = async () => answers.shift() ?? null

    await keySeq(editor, "C-c", ",")
    expect(buffer.text).toBe("* TODO [#A] Task\n* Plain\n")

    await editor.run("org-priority")
    expect(buffer.text).toBe("* TODO Task\n* Plain\n")
  })
})

describe("promote / demote (M-left / M-right)", () => {
  test("demote adds a star", async () => {
    const { editor, buffer } = setup("* A\n", 0)
    await editor.run("org-demote")
    expect(buffer.text).toBe("** A\n")
  })

  test("promote removes a star and floors at level 1", async () => {
    const { editor, buffer } = setup("** A\n", 0)
    await editor.run("org-promote")
    expect(buffer.text).toBe("* A\n")
    await editor.run("org-promote")
    expect(buffer.text).toBe("* A\n")
  })

  test("M-left / M-right dispatch via the mode keymap", async () => {
    const { editor, buffer } = setup("** A\n", 0)
    await keySeq(editor, "M-right")
    expect(buffer.text).toBe("*** A\n")
    buffer.point = 0
    await keySeq(editor, "M-left")
    expect(buffer.text).toBe("** A\n")
  })
})

describe("heading navigation (C-c C-n / C-c C-p)", () => {
  test("next/previous heading move point", async () => {
    const { editor, buffer } = setup(DOC, 0)
    await editor.run("org-next-visible-heading")
    expect(buffer.point).toBe(DOC.indexOf("** TODO Child A"))
    await editor.run("org-next-visible-heading")
    expect(buffer.point).toBe(DOC.indexOf("*** Grand"))
    await editor.run("org-previous-visible-heading")
    expect(buffer.point).toBe(DOC.indexOf("** TODO Child A"))
  })

  test("at last heading, next reports and stays put", async () => {
    const { editor, buffer } = setup(DOC, DOC.indexOf("* Second"))
    let msg = ""
    editor.events.on("message", ({ text }) => { msg = text })
    await editor.run("org-next-visible-heading")
    expect(msg).toContain("No next heading")
    expect(buffer.point).toBe(DOC.indexOf("* Second"))
  })

  test("C-c C-n dispatches via the mode keymap", async () => {
    const { editor, buffer } = setup(DOC, 0)
    await keySeq(editor, "C-c", "C-n")
    expect(buffer.point).toBe(DOC.indexOf("** TODO Child A"))
  })

  test("navigation commands use GNU Org names", () => {
    const { editor } = setup(DOC, 0)
    expect(editor.commands.get("org-next-heading")).toBeUndefined()
    expect(editor.commands.get("org-previous-heading")).toBeUndefined()
    expect(editor.commands.get("org-next-visible-heading")).toBeDefined()
    expect(editor.commands.get("org-previous-visible-heading")).toBeDefined()
  })
})

describe("org tables", () => {
  test("TAB aligns separator rows and moves to the next cell", async () => {
    const text = "| Name | Age |\n|---+---|\n| Al | 9 |\n"
    const { editor, buffer } = setup(text, text.indexOf("Name"))

    await keySeq(editor, "TAB")

    expect(buffer.text).toBe("| Name | Age |\n|------+-----|\n| Al   | 9   |\n")
    expect(buffer.point).toBe(buffer.text.indexOf("Age"))
  })

  test("RET aligns and moves below, creating a row at the end", async () => {
    const text = "| Name | Age |\n|---+---|\n| Al | 9 |\n"
    const { editor, buffer } = setup(text, text.indexOf("Age"))

    await keySeq(editor, "RET")
    expect(buffer.point).toBe(buffer.text.indexOf("9"))

    await keySeq(editor, "RET")
    expect(buffer.text).toBe("| Name | Age |\n|------+-----|\n| Al   | 9   |\n|      |     |\n")
    expect(buffer.lineCol().line).toBe(4)
  })

  test("S-TAB aligns and moves to the previous cell", async () => {
    const text = "| Name | Age |\n|---+---|\n| Al | 9 |\n"
    const { editor, buffer } = setup(text, text.indexOf("Age"))

    await keySeq(editor, "S-TAB")

    expect(buffer.text).toBe("| Name | Age |\n|------+-----|\n| Al   | 9   |\n")
    expect(buffer.point).toBe(buffer.text.indexOf("Name"))
  })

  test("C-c | converts a whitespace region to an org table", async () => {
    const { editor, buffer } = setup("Name Age\nAnn 9\n")
    buffer.mark = 0
    buffer.markActive = true
    buffer.point = buffer.text.length

    await keySeq(editor, "C-c", "|")

    expect(buffer.text).toBe("| Name | Age |\n| Ann  | 9   |\n")
    expect(buffer.point).toBe(2)
  })

  test("row and column commands mirror markdown table operations", async () => {
    const text = "| Name | Age |\n|---+---|\n| Al | 9 |\n"
    const { editor, buffer } = setup(text, text.indexOf("Al"))

    await editor.run("org-table-insert-row")
    expect(buffer.text).toBe("| Name | Age |\n|------+-----|\n|      |     |\n| Al   | 9   |\n")

    buffer.point = buffer.text.indexOf("Al")
    await editor.run("org-table-kill-row")
    expect(buffer.text).toBe("| Name | Age |\n|------+-----|\n|      |     |\n")

    buffer.point = buffer.text.indexOf("Age")
    await editor.run("org-table-insert-column")
    expect(buffer.text).toBe("| Name |   | Age |\n|------+---+-----|\n|      |   |     |\n")

    buffer.point = buffer.text.indexOf("Age")
    await editor.run("org-table-delete-column")
    expect(buffer.text).toBe("| Name |   |\n|------+---|\n|      |   |\n")
  })

  test("S-M-arrow table bindings do table ops and fall back outside tables", async () => {
    const text = "* Head\n| A | B |\n|---+---|\n| x | y |\n"
    const { editor, buffer } = setup(text, text.indexOf("x"))

    await keySeq(editor, "M-S-down")
    expect(buffer.text).toContain("|   |   |\n| x | y |")

    buffer.point = 0
    await keySeq(editor, "M-S-right")
    expect(buffer.text.startsWith("** Head")).toBe(true)
  })
})

describe("org links", () => {
  test("org-insert-link prompts for target and description", async () => {
    const { editor, buffer } = setup("")
    const prompts: string[] = []
    const answers = ["https://example.com", "Example"]
    editor.prompt = async prompt => {
      prompts.push(prompt)
      return answers.shift() ?? null
    }

    await editor.run("org-insert-link")

    expect(prompts).toEqual(["Link: ", "Description: "])
    expect(buffer.text).toBe("[[https://example.com][Example]]")
  })

  test("org-open-at-point opens http links with the platform opener", async () => {
    const spawned: string[][] = []
    setPlatformRuntime({
      spawnProcess: options => {
        spawned.push(options.cmd)
        return { stdin: null, stdout: null, stderr: null, exited: Promise.resolve(0), kill() {} }
      },
    })
    try {
      const { editor, buffer } = setup("[[https://example.com][Example]]\n", 2)
      await editor.run("org-open-at-point")
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(spawned[0]?.at(-1)).toBe("https://example.com")
    } finally {
      setPlatformRuntime(undefined)
    }
  })

  test("org-open-at-point jumps to star headline links", async () => {
    const text = "[[*Target][jump]]\n* Target\n"
    const { editor, buffer } = setup(text, text.indexOf("[[*Target"))

    await editor.run("org-open-at-point")

    expect(buffer.point).toBe(text.indexOf("* Target"))
  })

  test("org-next-link and org-previous-link move between links", async () => {
    const text = "a [[one]] b [[two]] c\n"
    const { editor, buffer } = setup(text, 0)

    await editor.run("org-next-link")
    expect(buffer.point).toBe(text.indexOf("[[one]]"))
    await editor.run("org-next-link")
    expect(buffer.point).toBe(text.indexOf("[[two]]"))
    await editor.run("org-previous-link")
    expect(buffer.point).toBe(text.indexOf("[[one]]"))
  })

  test("font-lock marks org links", () => {
    const { buffer } = setup("[[https://example.com][Example]]\n")
    const spans = orgFontLock(buffer)
    expect(spans.some(span => String(span.face) === "markdown-link" && span.start === 0)).toBe(true)
  })
})

describe("org checkboxes", () => {
  test("org-toggle-checkbox toggles and updates slash statistics", async () => {
    const text = "* Tasks [0/2]\n- [ ] one\n- [X] two\n"
    const { editor, buffer } = setup(text, text.indexOf("[ ]"))

    await editor.run("org-toggle-checkbox")

    expect(buffer.text).toBe("* Tasks [2/2]\n- [X] one\n- [X] two\n")
  })

  test("org-toggle-checkbox updates percent statistics", async () => {
    const text = "- Parent [50%]\n  - [X] one\n  - [X] two\n"
    const { editor, buffer } = setup(text, text.indexOf("[X] two"))

    await editor.run("org-toggle-checkbox")

    expect(buffer.text).toBe("- Parent [50%]\n  - [X] one\n  - [ ] two\n")
  })
})

describe("org-ctrl-c-ctrl-c", () => {
  test("aligns tables at point", async () => {
    const text = "| A | Long |\n|---+---|\n| x | y |\n"
    const { editor, buffer } = setup(text, text.indexOf("Long"))

    await keySeq(editor, "C-c", "C-c")

    expect(buffer.text).toBe("| A | Long |\n|---+------|\n| x | y    |\n")
  })

  test("toggles checkboxes at point", async () => {
    const { editor, buffer } = setup("- [ ] todo\n", 0)

    await keySeq(editor, "C-c", "C-c")

    expect(buffer.text).toBe("- [X] todo\n")
  })

  test("reports when no org context handles it", async () => {
    const { editor } = setup("plain\n", 0)
    let msg = ""
    editor.events.on("message", ({ text }) => { msg = text })

    await keySeq(editor, "C-c", "C-c")

    expect(msg).toContain("no effect")
  })
})

describe("font-lock", () => {
  test("stars=comment, TODO=keyword, DONE=string, title=function", () => {
    const { buffer } = setup(DOC)
    const spans = orgFontLock(buffer)
    const faceAt = (pos: number) => spans.find(s => s.start <= pos && pos < s.end)?.face
    expect(faceAt(DOC.indexOf("* Top"))).toBe("comment")
    expect(faceAt(DOC.indexOf("Top"))).toBe("function")
    expect(faceAt(DOC.indexOf("TODO"))).toBe("keyword")
    expect(faceAt(DOC.indexOf("DONE"))).toBe("string")
    expect(faceAt(DOC.indexOf("Child A"))).toBe("function")
    expect(faceAt(DOC.indexOf("body a"))).toBeUndefined()
  })

  test("mode registers fontLock so the display layer reaches it", () => {
    setup(DOC)
    expect(getMode("org-mode")?.fontLock).toBe(orgFontLock)
  })
})

describe("auto-mode", () => {
  test("find-file-hook switches .org buffers into org-mode", async () => {
    const editor = makeEditor()
    install(editor)
    const buffer = editor.scratch("notes", "* h\n", "text")
    buffer.path = "/tmp/notes.org"
    await editor.runHook("find-file-hook", buffer)
    expect(buffer.mode).toBe("org-mode")
  })
})
