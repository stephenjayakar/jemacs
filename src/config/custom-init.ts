import type { Editor } from "../kernel/editor"
import { setTransientMarkModeEnabled } from "../kernel/transient-mark"
import { defcustom, defgroup, getCustom, setCustom } from "../runtime/custom"
// Side-effecting import: registers `cursor-type` so a config can `setCustom` it
// before anything in src/display has been loaded.
import "../display/cursor-type"
// Same reason for `jemacs-app-name`: a config sets it before any host builds a
// display model.
import "../runtime/app-name"

/** The core `defgroup` tree. The sixteen children of `emacs` and their order
 *  are exactly `(get 'emacs 'custom-group)` in GNU Emacs 30, so `M-x customize`
 *  opens onto the same listing; everything else hangs off one of them. */
function installDefaultCustomGroups(): void {
  // Root children, in Emacs's declaration order.
  defgroup("editing", "Basic text editing facilities.")
  defgroup("convenience", "Convenience features for faster editing.")
  defgroup("files", "Support for editing files.")
  defgroup("wp", "Support for editing text files.\nAlso see the `text' group.")
  defgroup("text", "Support for editing text files.")
  defgroup("data", "Support for editing binary data files.")
  defgroup("external", "Interfacing to external utilities.")
  // Emacs names this group `comm' but tags it "Communication".
  defgroup("comm", "Communications, networking, and remote access to files.", { tag: "Communication" })
  defgroup("programming", "Support for programming in other languages.")
  defgroup("applications", "Applications written in Emacs.")
  defgroup("development", "Support for further development of Emacs.")
  defgroup("environment", "Fitting Emacs with its environment.")
  defgroup("faces", "Support for multiple fonts.")
  defgroup("help", "Support for Emacs help systems.")
  defgroup("multimedia", "Non-textual support, specifically images and sound.")
  defgroup("local", "Code local to your site.")

  // Second level, each under the parent Emacs gives it.
  defgroup("customize", "Customization of the Customization support.", { parent: "help" })
  defgroup("custom-buffer", "Control the customization buffer.", { parent: "customize" })
  defgroup("custom-browse", "Control the customization browser.", { parent: "customize" })
  defgroup("custom-faces", "Faces used by customize.", { parent: "customize" })
  defgroup("tools", "Programming tools.", { parent: "programming" })
  defgroup("languages", "Modes for editing programming languages.", { parent: "programming" })
  defgroup("lisp", "Lisp support, including Emacs Lisp.", { parent: "languages" })
  defgroup("basic-faces", "The standard faces of Emacs.", { parent: "faces" })
  defgroup("display", "How characters are displayed in buffers.", { parent: "environment" })
  defgroup("frames", "Support for Emacs frames and window systems.", { parent: "environment" })
  defgroup("windows", "Windows within a frame.", { parent: "environment" })
  defgroup("minibuffer", "Controlling the behavior of the minibuffer.", { parent: "environment" })
  defgroup("mode-line", "Contents of the mode line.", { parent: "environment" })
  defgroup("mouse", "Input from the mouse.", { parent: "environment" })
  defgroup("keyboard", "Input from the keyboard.", { parent: "environment" })
  defgroup("terminals", "Terminal support.", { parent: "environment" })
  defgroup("killing", "Killing and yanking commands.", { parent: "editing" })
  defgroup("indent", "Indentation commands.", { parent: "editing" })
  defgroup("fill", "Indenting and filling text.", { parent: "editing" })
  defgroup("matching", "Various sorts of searching and matching.", { parent: "editing" })
  defgroup("outlines", "Support for hierarchical outlining.", { parent: "text" })
  defgroup("backup", "Backups of edited data files.", { parent: "files" })
  defgroup("auto-save", "Preventing accidental loss of data.", { parent: "files" })
  defgroup("find-file", "Finding files.", { parent: "files" })
  defgroup("dired", "Directory editing.", { parent: "files" })
  defgroup("processes", "Process, subshell, compilation, and job control support.", { parent: "external" })
  defgroup("comint", "Generic command interpreter in a buffer.", { parent: "processes" })
  defgroup("vc", "Version control systems.", { parent: "tools" })
  defgroup("diff", "Comparing files with `diff'.", { parent: "tools" })
  defgroup("ediff", "A comprehensive visual interface to diff & patch.", { parent: "tools" })
  defgroup("whitespace", "Visualize blanks (TAB, (HARD) SPACE and NEWLINE).", { parent: "convenience" })
  defgroup("hi-lock", "Interactively highlight text.", { parent: "matching" })
  defgroup("flyspell", "Spell checking on the fly.", { parent: "wp" })
  defgroup("org", "Outline-based notes management and organizer.", { parent: "outlines" })

  // Jemacs-only groups, parented where Emacs would put their nearest analogue.
  defgroup("magit", "A Git porcelain inside Jemacs.", { parent: "tools" })
  defgroup("vc-dir", "VC status buffers.", { parent: "vc" })
  defgroup("jproced", "Process management, in the manner of proced.", { parent: "processes" })
  defgroup("shadow", "Low-latency remote editing over the Shadow protocol.", { parent: "comm" })
  defgroup("transient", "Transient popup command menus.", { parent: "convenience" })
}

export function installDefaultCustomVariables(editor: Editor): void {
  installDefaultCustomGroups()
  defcustom("lsp-remote-host", "string", null, "Remote SSH host to run language servers on.", "tools")
  defcustom("transient-mark-mode", "boolean", true, "When non-nil, movement deactivates the mark (region highlight remains).", "editing")
  setTransientMarkModeEnabled(getCustom<boolean>("transient-mark-mode") ?? true)

  const setTransientMarkMode = (enabled: boolean): void => {
    setCustom("transient-mark-mode", enabled)
    setTransientMarkModeEnabled(enabled)
    editor.message(`Transient Mark mode ${enabled ? "on" : "off"}`)
  }

  editor.command("transient-mark-mode", ({ prefixArgument }) => {
    const next = prefixArgument == null
      ? !(getCustom<boolean>("transient-mark-mode") ?? true)
      : prefixArgument > 0
    setTransientMarkMode(next)
  }, "Toggle Transient Mark mode interactively.")

  editor.command("jemacs-toggle-transient-mark-mode", () => {
    const next = !(getCustom<boolean>("transient-mark-mode") ?? true)
    setTransientMarkMode(next)
  }, "Jemacs extension alias for transient-mark-mode toggle.")
}
