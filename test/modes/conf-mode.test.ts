import { expect, test } from "bun:test"
import { BufferModel } from "../../src/kernel/buffer"
import { getMode, modeFeature, type TextSpan } from "../../src/modes/mode"
import { confColonFontLock, confFontLock, confIndentLine, installConfMode } from "../../src/modes/conf"

function expectSpan(text: string, spans: TextSpan[], needle: string, face: TextSpan["face"]): void {
  const start = text.indexOf(needle)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(spans).toContainEqual({ start, end: start + needle.length, face })
}

test("conf-mode registers GNU conf mode names", () => {
  installConfMode()

  expect(getMode("conf-mode")?.parent).toBe("text")
  expect(getMode("conf-mode")?.commentStart).toBe("#")
  expect(getMode("conf-unix-mode")?.parent).toBe("conf-mode")
  expect(getMode("conf-unix-mode")?.commentStart).toBe("#")
  expect(getMode("conf-windows-mode")?.parent).toBe("conf-mode")
  expect(getMode("conf-windows-mode")?.commentStart).toBe(";")
  expect(getMode("conf-space-mode")?.parent).toBe("conf-mode")
  expect(getMode("conf-colon-mode")?.parent).toBe("conf-mode")
  expect(getMode("conf-javaprop-mode")?.parent).toBe("conf-mode")
  expect(modeFeature("conf-space-mode", "indentLine")).toBe(confIndentLine)
})

test("conf-mode font-lock highlights comments, sections, keys, and values", () => {
  installConfMode()
  const text = [
    "# top comment",
    "[server]",
    "host = \"localhost\" # inline comment",
    "port: 5432",
  ].join("\n")
  const buffer = new BufferModel({ name: "app.conf", text, mode: "conf-mode" })
  const spans = confFontLock(buffer)

  expectSpan(text, spans, "# top comment", "comment")
  expectSpan(text, spans, "[server]", "type")
  expectSpan(text, spans, "host", "constant")
  expectSpan(text, spans, "\"localhost\"", "string")
  expectSpan(text, spans, "# inline comment", "comment")
  expectSpan(text, spans, "port", "constant")
  expectSpan(text, spans, "5432", "string")

  const ranged = confFontLock(buffer, { startLine: 1, endLine: 3, start: buffer.lineStarts[1]!, end: buffer.lineStarts[3]! })
  expect(ranged.some(span => text.slice(span.start, span.end) === "# top comment")).toBe(false)
  expectSpan(text, ranged, "[server]", "type")
  expectSpan(text, ranged, "host", "constant")
})

test("conf-windows-mode uses semicolon comments", () => {
  installConfMode()
  const text = [
    "; top comment",
    "[main]",
    "path: C:\\Temp ; trailing comment",
  ].join("\n")
  const buffer = new BufferModel({ name: "system.ini", text, mode: "conf-windows-mode" })
  const fontLock = modeFeature("conf-windows-mode", "fontLock")
  expect(fontLock).toBeDefined()
  const spans = fontLock!(buffer)

  expectSpan(text, spans, "; top comment", "comment")
  expectSpan(text, spans, "[main]", "type")
  expectSpan(text, spans, "path", "constant")
  expectSpan(text, spans, "C:\\Temp", "string")
  expectSpan(text, spans, "; trailing comment", "comment")
})

test("conf-space-mode highlights whitespace-separated key values", () => {
  installConfMode()
  const text = "max_clients 128\n"
  const buffer = new BufferModel({ name: "service.conf", text, mode: "conf-space-mode" })
  const fontLock = modeFeature("conf-space-mode", "fontLock")
  expect(fontLock).toBeDefined()
  const spans = fontLock!(buffer)

  expectSpan(text, spans, "max_clients", "constant")
  expectSpan(text, spans, "128", "string")
})

test("conf-space-mode keeps = and : inside values (ssh config)", () => {
  installConfMode()
  const text = [
    "Host bastion",
    "  ProxyCommand ssh -W %h:%p jump",
    "  IdentityFile ~/.ssh/id_ed25519",
  ].join("\n")
  const buffer = new BufferModel({ name: "config", text, mode: "conf-space-mode" })
  const spans = modeFeature("conf-space-mode", "fontLock")!(buffer)

  expectSpan(text, spans, "Host", "constant")
  expectSpan(text, spans, "bastion", "string")
  expectSpan(text, spans, "ProxyCommand", "constant")
  expectSpan(text, spans, "ssh -W %h:%p jump", "string")
  expectSpan(text, spans, "IdentityFile", "constant")
  expectSpan(text, spans, "~/.ssh/id_ed25519", "string")
})

test("conf-colon-mode splits on colons only", () => {
  installConfMode()
  const text = "host: a=b\n"
  const buffer = new BufferModel({ name: "app.conf", text, mode: "conf-colon-mode" })
  const spans = confColonFontLock(buffer)

  expectSpan(text, spans, "host", "constant")
  expectSpan(text, spans, "a=b", "string")
})

test("conf-mode indentation is a no-op", () => {
  const buffer = new BufferModel({ name: "app.conf", text: "  key = value\n", mode: "conf-mode" })
  buffer.point = 2

  confIndentLine(buffer)

  expect(buffer.text).toBe("  key = value\n")
  expect(buffer.point).toBe(2)
})
