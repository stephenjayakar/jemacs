import { defcustom, getCustom } from "./custom"

/** The name the editor calls itself in the title row and in the GUI window title.
 *
 *  Emacs hard-codes "GNU Emacs" in `frame-title-format`; here the name is an
 *  option, because a user who renames the app wants every surface renamed at
 *  once. An empty value keeps each host's own name ("Jemacs GUI",
 *  "Jemacs OpenTUI", "Jemacs Web"), which is the default. */
defcustom("jemacs-app-name", "string", "",
  `Name shown in the title row and in the GUI window title.
When empty, each host uses its own name, for example "Jemacs GUI".`, "frames")

/** The configured application name, or FALLBACK when the option is empty. */
export function appName(fallback = "Jemacs"): string {
  const name = getCustom<string>("jemacs-app-name")
  return name && name.trim() ? name.trim() : fallback
}
