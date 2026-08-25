import { afterEach, expect, test } from "bun:test"
import { buildDisplayModel } from "../../src/display/build-display-model"
import { themedTextPlain } from "../../src/display/themed-text"
import { Editor } from "../../src/kernel/editor"
import { installDefaultConfig } from "../../src/config"
import { installDefaultModes } from "../../src/modes/default-modes"
import { appName } from "../../src/runtime/app-name"
import { setCustom } from "../../src/runtime/custom"

// The option is process-global, so every test restores the default.
afterEach(() => setCustom("jemacs-app-name", ""))

function titleFor(hostLabel: string): string {
  installDefaultModes()
  const editor = new Editor()
  installDefaultConfig(editor)
  editor.scratch("app-name-test", "hello", "text")
  const model = buildDisplayModel(editor, { lastMessage: "", viewport: { rows: 30, cols: 80 }, hostLabel })
  return themedTextPlain(model.title)
}

test("the title row uses the host name when jemacs-app-name is empty", () => {
  expect(titleFor("Jemacs GUI")).toContain("Jemacs GUI")
})

test("jemacs-app-name replaces the host name in the title row", () => {
  installDefaultConfig(new Editor())
  setCustom("jemacs-app-name", "emacs")
  const title = titleFor("Jemacs GUI")
  expect(title).toContain("emacs \u2014 app-name-test")
  expect(title).not.toContain("Jemacs")
})

test("appName returns the fallback for an empty or blank option", () => {
  installDefaultConfig(new Editor())
  expect(appName("Jemacs Web")).toBe("Jemacs Web")
  setCustom("jemacs-app-name", "   ")
  expect(appName("Jemacs Web")).toBe("Jemacs Web")
  setCustom("jemacs-app-name", "emacs")
  expect(appName("Jemacs Web")).toBe("emacs")
  expect(appName()).toBe("emacs")
})
