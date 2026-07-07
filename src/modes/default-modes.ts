import { defineMode } from "./mode"
import { installBufferListMode } from "./buffer-list"
import { installCustomizeMode } from "./customize"
import { installDiredMode } from "./dired"
import { installLinumMode } from "./linum-mode"
import { installHelpMode } from "./help"
import { installMinibufferMode } from "./minibuffer"
import { installPythonMode } from "./python"
import { installShellScriptMode } from "./shell-script"
import { installConfigModes } from "./generic"
import { installEmacsLispMode } from "./emacs-lisp"
import { installDiffMode } from "./diff"
import { installCssMode } from "./css"
import { installTomlMode } from "./toml"
import { installConfMode } from "./conf"
import { installMakefileMode } from "./makefile"
import { installDockerfileMode } from "./dockerfile"
import { installCppMode } from "./cpp"
import { installLispModes } from "./lisp"
import { installXmlMode } from "./xml"
import { installOutlineMode } from "./outline"
import { installRstMode } from "./rst"
import { installTexModes } from "./tex"
import { installCmakeMode } from "./cmake"
import { installGoModModes } from "./go-mod"
import { installLogModes } from "./log"

export function installDefaultModes(): void {
  installLinumMode()
  defineMode({ name: "text" })
  installMinibufferMode()
  installHelpMode()
  installCustomizeMode()
  defineMode({ name: "prog-mode", parent: "text" })
  installConfigModes()
  installEmacsLispMode()
  installPythonMode()
  installShellScriptMode()
  installDiffMode()
  installCssMode()
  installTomlMode()
  installConfMode()
  installMakefileMode()
  installDockerfileMode()
  installCppMode()
  installLispModes()
  installXmlMode()
  installOutlineMode()
  installRstMode()
  installTexModes()
  installCmakeMode()
  installGoModModes()
  installLogModes()
  installBufferListMode()
  installDiredMode()
}
