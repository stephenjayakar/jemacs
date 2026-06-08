import { dirname } from "node:path"
import { homedir } from "node:os"
import type { SaveContext } from "../src/kernel/buffer"
import type { CommandContext } from "../src/kernel/command"
import type { Editor } from "../src/kernel/editor"
import { setModeSystem } from "../src/kernel/extension-points"
import { createPluginContext, type PluginContext } from "../src/runtime/plugin-context"
import { readKey } from "./misc"
import { readFileText } from "../src/platform/runtime"
import { defcustom, getCustom } from "../src/runtime/custom"
import { saveContextOptions } from "../src/core/save-context"
import {
  diredCreateDirectory,
  diredDoCopy,
  diredDoDelete,
  diredDoFlaggedDelete,
  diredDoRename,
  diredEntryAtPoint,
  diredFlagFileDeletion,
  diredMarkEntry,
  diredMarkFilesRegexp,
  diredToggleMarks,
  diredToggleMark,
  diredUnmarkAll,
  diredUnmarkAllFiles,
  diredUnmarkBackward,
  diredUnmarkEntry,
  makeDirectory,
  makeDiredBuffer,
  refreshDiredBuffer,
} from "../src/modes/dired"

// Kernel's openDirectory routes through this seam so kernel/ stays free of modes/dired.
setModeSystem({ makeDirectoryBuffer: makeDiredBuffer })

defcustom("make-backup-files", "boolean", true,
  "Non-nil means make a backup of a file the first time it is saved.")

/** Emacs `substitute-in-file-name`: typing an absolute path or `~` after the
 *  prefilled directory restarts from there, so `/a/b//etc/x` → `/etc/x`.
 *  A leading `~` is expanded so node:path `resolve()` doesn't treat it as a
 *  literal directory component. */
export function substituteInFileName(input: string): string {
  const restart = Math.max(input.lastIndexOf("//"), input.lastIndexOf("/~"))
  const stripped = restart >= 0 ? input.slice(restart + 1) : input
  if (stripped === "~" || stripped.startsWith("~/")) return homedir() + stripped.slice(1)
  return stripped
}

export function directoryInitialValue(directory: string): string {
  return directory.endsWith("/") ? directory : `${directory}/`
}

export function install(editor: Editor, ctx: PluginContext = createPluginContext(editor)): void {
  // SaveContext shared by every command-layer save path so the mtime-clash
  // confirm and make-backup-files defcustom apply uniformly. Hooks are *not*
  // included by default — save-buffer's hooks are advice-driven and swallow
  // errors; callers that bypass that command (save-some-buffers) opt in.
  const saveCtx = (extra?: SaveContext): SaveContext => ({
    confirm: async (p: string) => (await readKey(editor, `${p} (y or n) `)) === "y",
    ...saveContextOptions(),
    ...extra,
  })

  editor.command("save-buffer", async ({ buffer, editor }) => {
    try {
      await buffer.save(saveCtx())
      editor.message(`Saved ${buffer.path}`)
    } catch (err) {
      editor.message((err as Error).message)
    }
  }, "Save the current buffer to disk.")

  const findFile = async ({ editor, args }: CommandContext) => {
    const input = args[0] ?? await editor.completingRead("Find file: ", {
      completion: "file",
      history: "file",
      initialValue: directoryInitialValue(editor.currentBuffer.directory() ?? process.cwd()),
    })
    if (!input) return
    const path = substituteInFileName(input)
    await editor.openFile(path)
    editor.message(`Opened ${path}`)
  }

  editor.command("find-file", findFile, "Open a file into a buffer.")

  editor.command("write-file", async ({ buffer, editor, args }) => {
    const path = args[0] ?? await editor.prompt("Write file: ", buffer.path ?? "", "write-file")
    if (!path) return
    buffer.path = path
    try {
      await buffer.save(saveCtx({ runHook: editor.runHook.bind(editor) }))
      editor.message(`Wrote ${path}`)
    } catch (err) {
      editor.message((err as Error).message)
    }
  }, "Write the current buffer to a specified file.")

  editor.command("find-alternate-file", async ({ buffer, editor, args }) => {
    const path = args[0] ?? await editor.completingRead("Find alternate file: ", {
      completion: "file",
      history: "file",
      initialValue: buffer.directory() ?? process.cwd(),
    })
    if (!path) return
    if (buffer.dirty && buffer.path) {
      const ans = await readKey(editor, `Buffer ${editor.bufferDisplayName(buffer)} modified; kill anyway? (y or n) `)
      if (ans !== "y") { editor.message("Cancelled"); return }
    }
    try {
      const text = await readFileText(path)
      buffer.path = path
      buffer.name = path.split("/").pop() ?? path
      buffer.setText(text, false)
      buffer.dirty = false
      buffer.point = Math.min(buffer.point, buffer.text.length)
      editor.enterMode(buffer, buffer.mode)
      editor.message(`Now visiting ${path}`)
    } catch (err) {
      editor.message((err as Error).message)
    }
  }, "Replace this buffer with the contents of another file.")

  editor.command("kill-buffer", async ({ editor, args }) => {
    const name = args[0] ?? await editor.completingRead("Kill buffer: ", {
      collection: [...editor.buffers.values()].filter(b => b.kind !== "minibuffer").map(b => editor.bufferDisplayName(b)),
      history: "buffer",
      initialValue: editor.bufferDisplayName(editor.currentBuffer),
    })
    if (!name) return
    const target = editor.buffers.get(name)
      ?? [...editor.buffers.values()].find(b => b.name === name || editor.bufferDisplayName(b) === name)
    const display = target ? editor.bufferDisplayName(target) : name
    if (target?.dirty && target.path) {
      const ans = await readKey(editor, `Buffer ${display} modified; kill anyway? (y, n, s) `)
      if (ans === "s") {
        try { await target.save(saveCtx()) }
        catch (err) { editor.message((err as Error).message); return }
      } else if (ans !== "y") { editor.message("Cancelled"); return }
    }
    const killed = editor.killBuffer(name)
    if (killed) editor.message(`Killed buffer ${display}`)
  }, "Kill the current buffer or a specified buffer.")

  const revertBuffer = async ({ buffer, editor, args }: CommandContext) => {
    if (!buffer.path) {
      editor.message("Current buffer is not visiting a file")
      return
    }
    if (buffer.kind === "directory") {
      await refreshDiredBuffer(buffer)
      editor.message(`Reverted ${buffer.path}`)
      return
    }
    // Emacs gates on confirmation when modified (files.el:7102); auto-revert passes noconfirm to bypass.
    if (buffer.dirty && !args[0]) {
      const ans = await readKey(editor, `Discard edits and reread from ${buffer.path}? (y or n) `)
      if (ans !== "y") { editor.message("Revert cancelled"); return }
    }
    await buffer.revert()
    buffer.point = Math.min(buffer.point, buffer.text.length)
    editor.message(`Reverted ${editor.bufferDisplayName(buffer)}`)
  }
  editor.command("revert-buffer", revertBuffer, "Reload the current file or directory from disk, confirming first if the buffer is modified.")

  editor.command("save-some-buffers", async ({ editor }) => {
    const dirty = [...editor.buffers.values()].filter(b => b.dirty && b.path && b.kind === "file")
    let saveAll = false
    let saved = 0
    const failed: string[] = []
    const runHook = editor.runHook.bind(editor)
    for (const b of dirty) {
      const trySave = async (ctx: SaveContext) => {
        try { await b.save(ctx); saved++ }
        catch (err) { failed.push(`${b.path}: ${(err as Error).message}`) }
      }
      // Buffers with buffer-save-without-query set save silently (files.el:6370).
      if (b.locals.get("buffer-save-without-query")) { await trySave(saveCtx({ runHook, force: true })); continue }
      let answer = saveAll ? "y" : (await editor.prompt(`Save file ${b.path}? (y, n, !, ., q) `, "", "save-some-buffers"))?.trim()
      if (answer == null || answer === "q") break
      if (answer === "!") { saveAll = true; answer = "y" }
      if (answer === "y" || answer === ".") await trySave(saveCtx({ runHook }))
      if (answer === ".") break
    }
    const summary = dirty.length ? `Saved ${saved} of ${dirty.length} file(s)` : "(No files need saving)"
    editor.message(failed.length ? `${summary}; ${failed.length} failed: ${failed.join("; ")}` : summary)
  }, "Save some modified file-visiting buffers, asking about each one.")

  editor.command("save-buffers-kill-terminal", async ({ editor }) => {
    await editor.run("save-some-buffers")
    // Declining a save above must not silently discard edits (files.el:8212).
    if ([...editor.buffers.values()].some(b => b.dirty && b.path)) {
      if ((await readKey(editor, "Modified buffers exist; exit anyway? (y or n) ")) !== "y") return
    }
    editor.message("Quit requested")
    editor.quit()
  }, "Offer to save modified buffers, then quit the editor.")

  editor.command("make-directory", async ({ buffer, editor, args }) => {
    const parent = buffer.directory() ?? process.cwd()
    await makeDirectory(editor, parent, args[0], buffer.kind === "directory" ? buffer : undefined)
  }, "Create a new directory.")

  // --- dired ---

  editor.command("dired", async ({ editor, args }) => {
    const path = args[0] ?? await editor.completingRead("Dired: ", { completion: "file", history: "file", initialValue: directoryInitialValue(editor.currentBuffer.directory() ?? process.cwd()) })
    if (!path) return
    await editor.openDirectory(substituteInFileName(path))
  }, "Open a directory in Dired.")
  const diredRevert = async ({ buffer, editor }: CommandContext) => {
    await refreshDiredBuffer(buffer)
    editor.message(`Reverted ${buffer.path}`)
  }
  editor.command("dired-revert", diredRevert, "Refresh the current Dired buffer.")
  editor.command("dired-find-file", async ({ buffer, editor }) => {
    const entry = diredEntryAtPoint(buffer)
    if (!entry) return
    await editor.openFile(entry.path)
  }, "Visit the file or directory on the current Dired line.")
  editor.command("dired-up-directory", async ({ buffer, editor }) => {
    if (!buffer.path) return
    await editor.openDirectory(dirname(buffer.path))
  }, "Open the parent directory in Dired.")
  editor.command("dired-mark", ({ buffer }) => {
    diredMarkEntry(buffer, diredEntryAtPoint(buffer), "marked")
  }, "Mark the current Dired line.")
  editor.command("dired-unmark", ({ buffer }) => {
    diredUnmarkEntry(buffer, diredEntryAtPoint(buffer))
  }, "Unmark the current Dired line.")
  const diredUnmarkAllMarks = ({ buffer, editor }: CommandContext) => {
    diredUnmarkAll(buffer)
    editor.message("Unmarked all")
  }
  editor.command("dired-unmark-all-marks", diredUnmarkAllMarks, "Remove all marks and deletion flags in Dired.")
  editor.command("dired-unmark-all", diredUnmarkAllMarks, "Compatibility alias for dired-unmark-all-marks.")
  editor.command("dired-unmark-all-files", async ({ buffer, editor, args, prefixArgument }) => {
    const input = args[0] ?? await editor.prompt("Remove marks (RET means all): ", "", "dired-unmark")
    if (input == null) return
    const markChar = input === "" ? undefined : input[0]
    const count = await diredUnmarkAllFiles(buffer, markChar, prefixArgument == null ? undefined : async entry =>
      await readKey(editor, `Unmark ${entry.name}? (y or n) `) === "y")
    editor.message(`Removed ${count} mark${count === 1 ? "" : "s"}`)
  }, "Remove a specific mark, or any mark, from every file in Dired.")
  editor.command("dired-toggle-marks", ({ buffer }) => {
    diredToggleMarks(buffer)
  }, "Toggle Dired marks throughout the current buffer.")
  editor.command("dired-toggle-mark", ({ buffer }) => {
    diredToggleMark(buffer, diredEntryAtPoint(buffer))
  }, "Toggle the mark on the current Dired line.")
  editor.command("dired-mark-files-regexp", async ({ buffer, editor, args }) => {
    const regexp = args[0] ?? await editor.prompt("% m Mark files (regexp): ", "", "dired-regexp")
    if (!regexp) return
    const count = diredMarkFilesRegexp(buffer, regexp, "marked")
    editor.message(`Marked ${count} file(s)`)
  }, "Mark files whose names match a regular expression.")
  editor.command("dired-flag-files-regexp", async ({ buffer, editor, args }) => {
    const regexp = args[0] ?? await editor.prompt("% d Flag files (regexp): ", "", "dired-regexp")
    if (!regexp) return
    const count = diredMarkFilesRegexp(buffer, regexp, "delete")
    editor.message(`Flagged ${count} file(s) for deletion`)
  }, "Flag files for deletion by regular expression.")
  editor.command("dired-flag-file-deletion", ({ buffer }) => {
    diredFlagFileDeletion(buffer, diredEntryAtPoint(buffer))
  }, "Flag the current Dired line for deletion.")
  editor.command("dired-do-flagged-delete", async ({ buffer, editor }) => {
    await diredDoFlaggedDelete(editor, buffer)
  }, "Delete files flagged for deletion in Dired.")
  editor.command("dired-do-delete", async ({ buffer, editor, prefixArgument }) => {
    await diredDoDelete(editor, buffer, prefixArgument)
  }, "Delete file on the current line or marked files.")
  editor.command("dired-do-copy", async ({ buffer, editor, prefixArgument }) => {
    await diredDoCopy(editor, buffer, prefixArgument)
  }, "Copy marked files or the file on the current line.")
  editor.command("dired-do-rename", async ({ buffer, editor, prefixArgument }) => {
    await diredDoRename(editor, buffer, prefixArgument)
  }, "Rename a file or move marked files to another directory.")
  editor.command("dired-create-directory", async ({ buffer, editor, args }) => {
    if (!buffer.path || buffer.kind !== "directory") {
      editor.message("Not in Dired")
      return
    }
    await diredCreateDirectory(editor, buffer, args[0])
  }, "Create a new directory in the current Dired listing.")
  editor.command("dired-unmark-backward", ({ buffer }) => {
    diredUnmarkBackward(buffer)
  }, "Move up one line and unmark or unflag.")

  // --- key bindings ---

  editor.key("C-x C-s", "save-buffer")
  editor.key("C-x C-f", "find-file")
  editor.key("C-x C-w", "write-file")
  editor.key("C-x C-v", "find-alternate-file")
  editor.key("C-x C-r", "revert-buffer")
  editor.key("C-x s", "save-some-buffers")
  editor.key("C-x C-c", "save-buffers-kill-terminal")
  editor.key("C-c C-q", "save-buffers-kill-terminal")
  editor.key("C-x d", "dired")
}
