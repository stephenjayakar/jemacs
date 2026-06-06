import type { Editor } from "./kernel/editor"
import type { UiHost } from "./display/protocol"
import { runJemacsCore } from "./run-core"

export { bindJemacsHost, runJemacsCore } from "./run-core"
export type { JemacsHostBinding } from "./run-core"

export async function runJemacs(editor: Editor, host: UiHost): Promise<void> {
  await runJemacsCore(editor, host)
}
