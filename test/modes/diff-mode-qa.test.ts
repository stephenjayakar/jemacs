import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { script } from "../harness"
import { spawnProcess } from "../../src/platform/runtime"
import type { Editor } from "../../src/kernel/editor"
import type { BufferModel } from "../../src/kernel/buffer"

// QA: diff-mode via layer-1 script() harness, against a real temp git repo.
// Drives n/p nav, k kill-hunk, C-c C-a apply, C-c C-s, diff-kill-applied,
// and find-file on a .diff with font-lock + nav.

let repo = ""

async function git(args: string[]): Promise<string> {
  // Pin a/ b/ prefixes: the assertions below must not depend on the
  // developer's `diff.mnemonicPrefix` / `diff.noPrefix`.
  const pinned = ["-c", "diff.noPrefix=false", "-c", "diff.mnemonicPrefix=false"]
  const proc = spawnProcess({ cmd: ["git", ...pinned, ...args], cwd: repo, stdout: "pipe", stderr: "pipe" })
  const out = proc.stdout ? await new Response(proc.stdout).text() : ""
  const err = proc.stderr ? await new Response(proc.stderr).text() : ""
  const code = await proc.exited
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${err}`)
  return out
}

const ORIGINAL = [
  "alpha",
  "bravo",
  "charlie",
  "delta",
  "echo",
  "foxtrot",
  "golf",
  "hotel",
  "india",
  "juliet",
  "kilo",
  "lima",
  "",
].join("\n")

const MODIFIED = [
  "alpha",
  "BRAVO!",      // hunk 1: line 2 changed
  "charlie",
  "delta",
  "echo",
  "foxtrot",
  "golf",
  "HOTEL!",      // hunk 2: line 8 changed
  "INSERTED",    // hunk 2: line inserted
  "india",
  "juliet",
  "kilo",
  "lima",
  "",
].join("\n")

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "jemacs-diff-qa-"))
  await git(["init", "-q", "-b", "main"])
  await git(["config", "user.email", "qa@example.com"])
  await git(["config", "user.name", "qa"])
  await writeFile(join(repo, "file.txt"), ORIGINAL)
  await git(["add", "."])
  await git(["commit", "-q", "-m", "initial"])
  await writeFile(join(repo, "file.txt"), MODIFIED)
})

afterEach(async () => {
  if (repo) await rm(repo, { recursive: true, force: true })
})

/** Populate the current buffer with `git diff` output and arm diff-mode. */
async function openDiff(editor: Editor, buffer: BufferModel): Promise<void> {
  const out = await git(["diff", "-U1"])
  buffer.setText(out)
  buffer.mode = "diff-mode"
  buffer.point = 0
  buffer.locals.set("diff-default-directory", repo)
}

function lineAtPoint(buffer: BufferModel): string {
  return buffer.lineBoundsAt(buffer.point).text
}

describe("diff-mode QA: temp git repo via script()", () => {
  test("git diff produces two hunks against the modified working tree", async () => {
    const out = await git(["diff", "-U1"])
    const headers = [...out.matchAll(/^@@ .+ @@/gm)].map(m => m[0])
    expect(headers).toHaveLength(2)
    expect(out).toContain("-bravo")
    expect(out).toContain("+BRAVO!")
    expect(out).toContain("-hotel")
    expect(out).toContain("+HOTEL!")
    expect(out).toContain("+INSERTED")
  })

  test("n/p hunk navigation moves point between @@ headers", async () => {
    await script()
      .do(openDiff)
      .expect.that((_, b) => expect(b.mode).toBe("diff-mode"))
      // n → first hunk header
      .keys("n")
      .expect.that((_, b) => expect(lineAtPoint(b)).toMatch(/^@@ -\d+,?\d* \+\d+,?\d* @@/))
      .do((_, b) => {
        const firstHunk = b.text.indexOf("@@ ")
        expect(b.point).toBe(firstHunk)
      })
      // n → second hunk header
      .keys("n")
      .expect.that((_, b) => {
        const secondHunk = b.text.indexOf("@@ ", b.text.indexOf("@@ ") + 1)
        expect(b.point).toBe(secondHunk)
        expect(b.text.slice(b.point)).toContain("HOTEL!")
      })
      // p → back to first hunk header
      .keys("p")
      .expect.that((_, b) => {
        const firstHunk = b.text.indexOf("@@ ")
        expect(b.point).toBe(firstHunk)
      })
      // p again at first hunk → should not move past start / should be no-op or stay
      .keys("p")
      .expect.that((_, b) => {
        // point should not be past the first hunk header
        const firstHunk = b.text.indexOf("@@ ")
        expect(b.point).toBeLessThanOrEqual(firstHunk)
      })
      .done()
    // on-disk: navigation must not touch the working tree
    expect(await readFile(join(repo, "file.txt"), "utf8")).toBe(MODIFIED)
  })

  test("k (diff-hunk-kill) removes the current hunk from the buffer only", async () => {
    await script()
      .do(openDiff)
      .keys("n")            // → hunk 1
      .keys("k")            // kill hunk 1
      .expect.that((_, b) => {
        expect(b.text).not.toContain("BRAVO!")
        expect(b.text).not.toContain("-bravo")
        expect(b.text).toContain("HOTEL!")     // hunk 2 survives
        expect(b.text).toContain("+INSERTED")
        const headers = [...b.text.matchAll(/^@@ /gm)]
        expect(headers).toHaveLength(1)
      })
      .done()
    // on-disk: kill-hunk is buffer-only, working tree unchanged
    expect(await readFile(join(repo, "file.txt"), "utf8")).toBe(MODIFIED)
  })

  test("k then n lands on the surviving hunk", async () => {
    await script()
      .do(openDiff)
      .keys("n", "n")       // → hunk 2
      .keys("k")            // kill hunk 2
      .expect.that((_, b) => {
        expect(b.text).toContain("BRAVO!")
        expect(b.text).not.toContain("HOTEL!")
        expect(b.text).not.toContain("INSERTED")
      })
      .point(0)
      .keys("n")
      .expect.that((_, b) => expect(lineAtPoint(b)).toMatch(/^@@ /))
      .expect.that((_, b) => expect(b.text.slice(b.point)).toContain("BRAVO!"))
      .done()
  })

  test("C-c C-a (diff-apply-hunk) writes the hunk to disk via git apply", async () => {
    // openDiff captures the diff while file.txt = MODIFIED, then we reset the
    // working tree to ORIGINAL so the diff applies forward.
    let diffText = ""
    await script()
      .do(openDiff)
      .do(async () => { await writeFile(join(repo, "file.txt"), ORIGINAL) })
      .do((_, b) => { diffText = b.text })
      .keys("n")            // → hunk 1
      .keys("C-c", "C-a")   // diff-apply-hunk
      .expect.message("Applied patch")
      .expect.that((_, b) => {
        // buffer text should be unchanged by apply
        expect(b.text).toBe(diffText)
      })
      .done()
    // on-disk: hunk 1 applied, hunk 2 NOT applied
    const onDisk = await readFile(join(repo, "file.txt"), "utf8")
    expect(onDisk).toContain("BRAVO!")
    expect(onDisk).not.toContain("HOTEL!")
    expect(onDisk).not.toContain("INSERTED")
    expect(onDisk).toContain("hotel")  // hunk 2 not applied
  })

  // patchForHunk used to slice lines[file.startLine..hunk.startLine] and filter
  // only ^@@ / ^*** / ^NcN headers — so for the 2nd+ hunk it leaked the body of
  // preceding hunks between the +++ header and the @@ header, and git apply
  // rejected the result as corrupt. Now slices to the *first* hunk's start.
  test("C-c C-a on second hunk applies only that hunk", async () => {
    let lastMsg = ""
    await script()
      .do(openDiff)
      .do(async () => { await writeFile(join(repo, "file.txt"), ORIGINAL) })
      .do((e) => { e.events.on("message", ({ text }) => { lastMsg = text }) })
      .keys("n", "n")       // → hunk 2
      .keys("C-c", "C-a")   // diff-apply-hunk
      .done()
    const onDisk = await readFile(join(repo, "file.txt"), "utf8")
    // Expected behaviour (currently fails):
    expect(lastMsg).toBe("Applied patch")
    expect(onDisk).toContain("bravo")     // hunk 1 not applied
    expect(onDisk).not.toContain("BRAVO!")
    expect(onDisk).toContain("HOTEL!")    // hunk 2 applied
    expect(onDisk).toContain("INSERTED")
  })

  test("diff-test-hunk on the 2nd hunk reports a clean patch (regression: was corrupt)", async () => {
    let lastMsg = ""
    await script()
      .do(openDiff)
      .do(async () => { await writeFile(join(repo, "file.txt"), ORIGINAL) })
      .do((e) => { e.events.on("message", ({ text }) => { lastMsg = text }) })
      .keys("n", "n")
      .keys("C-c", "C-t")   // diff-test-hunk
      .done()
    expect(lastMsg).toBe("Patch applies cleanly")
    // diff-test-hunk is --check only; the working tree must be untouched.
    expect(await readFile(join(repo, "file.txt"), "utf8")).toBe(ORIGINAL)
  })

  test("C-c C-s is bound to diff-split-hunk (not 'save patch')", async () => {
    // Per src/modes/diff.ts keymap: C-c C-s → diff-split-hunk.
    // GNU Emacs diff-mode binds C-c C-s the same way; there is no
    // "save patch" command on this key. QA brief said "save patch" — verify
    // actual binding and behaviour.
    await script()
      .do(openDiff)
      .expect.that((e) => {
        const result = e.keymaps.lookup("C-c C-s")
        expect(result).toMatchObject({ status: "matched", command: "diff-split-hunk" })
      })
      .keys("n", "n")       // → hunk 2 header
      // move point into the hunk body so split has somewhere to cut
      .do((_, b) => { b.point = b.text.indexOf("+INSERTED") })
      .keys("C-c", "C-s")   // diff-split-hunk
      .expect.that((_, b) => {
        // after split, hunk 2 should become two hunks → 3 total
        const headers = [...b.text.matchAll(/^@@ /gm)]
        expect(headers).toHaveLength(3)
      })
      .done()
    // on-disk: split is buffer-only
    expect(await readFile(join(repo, "file.txt"), "utf8")).toBe(MODIFIED)
  })

  test("diff-kill-applied-hunks removes ALL applied hunks in a multi-hunk file", async () => {
    // Working tree already has BOTH changes (MODIFIED). With the diff loaded,
    // both hunks are "already applied" against the working tree → both should die.
    await script()
      .do(openDiff)
      .keys("n")            // point at hunk 1
      .run("diff-kill-applied-hunks")
      .expect.message("Killed 2 already-applied hunks")
      .expect.that((_, b) => {
        expect(b.text).not.toContain("@@ ")
        expect(b.text).not.toContain("BRAVO!")
        expect(b.text).not.toContain("HOTEL!")
      })
      .done()
    expect(await readFile(join(repo, "file.txt"), "utf8")).toBe(MODIFIED)
  })

  test("diff-kill-applied-hunks: first hunk is detected; on-disk untouched", async () => {
    // Current (buggy) behaviour: hunk 1 dies, hunk 2 survives because its
    // generated patch is corrupt. Locking in what works today.
    await script()
      .do(openDiff)
      .keys("n")
      .run("diff-kill-applied-hunks")
      .expect.message("Killed")
      .expect.that((_, b) => {
        expect(b.text).not.toContain("+BRAVO!")
      })
      .done()
    expect(await readFile(join(repo, "file.txt"), "utf8")).toBe(MODIFIED)
  })

  test("diff-kill-applied-hunks keeps unapplied hunks", async () => {
    const partial = ORIGINAL.replace("bravo", "BRAVO!")
    await script()
      .do(openDiff)
      .do(async () => { await writeFile(join(repo, "file.txt"), partial) })
      .keys("n")
      .run("diff-kill-applied-hunks")
      .expect.that((_, b) => {
        // hunk 1 (BRAVO) was applied → removed; hunk 2 (HOTEL) remains
        expect(b.text).not.toContain("+BRAVO!")
        expect(b.text).toContain("+HOTEL!")
        expect(b.text).toContain("+INSERTED")
        const headers = [...b.text.matchAll(/^@@ /gm)]
        expect(headers).toHaveLength(1)
      })
      .done()
    expect(await readFile(join(repo, "file.txt"), "utf8")).toBe(partial)
  })

  test("C-c C-m k key sequence triggers diff-kill-applied-hunks", async () => {
    await script()
      .do(openDiff)
      .expect.that((e) => {
        expect(e.keymaps.lookup("C-c C-m k")).toMatchObject({ status: "matched", command: "diff-kill-applied-hunks" })
      })
      .keys("n")
      .keys("C-c", "C-m", "k")
      .expect.message("Killed")
      .expect.that((_, b) => expect(b.text).not.toContain("+BRAVO!"))
      .done()
  })
})

describe("diff-mode QA: find-file on a .diff", () => {
  test("opening a .diff via find-file infers diff-mode, font-locks, and navigates", async () => {
    const diffOut = await git(["diff", "-U1"])
    const diffPath = join(repo, "changes.diff")
    await writeFile(diffPath, diffOut)

    const editor = await script()
      .run("find-file", diffPath)
      .expect.bufferName("changes.diff")
      .expect.that((_, b) => {
        expect(b.mode).toBe("diff-mode")
        expect(b.path).toBe(diffPath)
        expect(b.text).toContain("+BRAVO!")
      })
      // font-lock: assert face assignments on key line types
      .expect.that((e, b) => {
        const spans = e.fontLock(b)
        const faceAt = (needle: string) =>
          spans.find(s => s.start === b.text.indexOf(needle))?.face
        expect(faceAt("diff --git")).toBe("diffHeader")
        expect(faceAt("--- a/file.txt")).toBe("diffFileHeader")
        expect(faceAt("+++ b/file.txt")).toBe("diffFileHeader")
        expect(faceAt("@@ ")).toBe("diffHunkHeader")
        expect(faceAt("-bravo")).toBe("diffRemoved")
        expect(faceAt("+BRAVO!")).toBe("diffAdded")
        expect(faceAt(" alpha")).toBe("diffContext")
        expect(faceAt("index ")).toBe("diffIndex")
      })
      // nav: n/p work in the visited file too
      .point(0)
      .keys("n")
      .expect.that((_, b) => expect(lineAtPoint(b)).toMatch(/^@@ /))
      .keys("n")
      .expect.that((_, b) => {
        const second = b.text.indexOf("@@ ", b.text.indexOf("@@ ") + 1)
        expect(b.point).toBe(second)
      })
      .keys("p")
      .expect.that((_, b) => expect(b.point).toBe(b.text.indexOf("@@ ")))
      .done()

    // on-disk: visiting + nav must not modify the .diff file
    expect(await readFile(diffPath, "utf8")).toBe(diffOut)
    expect(editor.currentBuffer.dirty).toBe(false)
  })

  test("opening a .patch via find-file also infers diff-mode", async () => {
    const diffOut = await git(["diff", "-U1"])
    const patchPath = join(repo, "changes.patch")
    await writeFile(patchPath, diffOut)
    await script()
      .run("find-file", patchPath)
      .expect.that((_, b) => expect(b.mode).toBe("diff-mode"))
      .done()
  })
})
