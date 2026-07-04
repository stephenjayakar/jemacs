import { expect, test } from "bun:test"
import { makeEditor } from "./helper"
import {
  install,
  buildCurlInvocation,
  formatHttpResponse,
  nextRequestPoint,
  parseRequestAt,
  previousRequestPoint,
  requestStarts,
} from "../../plugins/restclient"
import { getMode } from "../../src/modes/mode"
import type { SpawnHandle, SpawnOptions } from "../../src/platform/runtime"

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

test("parseRequestAt parses method url headers body and substitutes prior variables", () => {
  const text = [
    ":host = https://api.example.test",
    ":token = secret",
    "# user lookup",
    "POST :host/users",
    "Authorization: Bearer :token",
    "Content-Type: application/json",
    "",
    "{\"name\":\":token\"}",
    "# next",
    "GET :host/ping",
    "",
  ].join("\n")
  const point = text.indexOf("Authorization")
  const req = parseRequestAt(text, point)

  expect(req).not.toBeNull()
  expect(req?.method).toBe("POST")
  expect(req?.url).toBe("https://api.example.test/users")
  expect(req?.headers).toEqual([
    { name: "Authorization", value: "Bearer secret" },
    { name: "Content-Type", value: "application/json" },
  ])
  expect(req?.body).toBe("{\"name\":\"secret\"}")
  expect(req?.blockEnd).toBe(text.indexOf("# next"))
})

test("parseRequestAt only uses variables defined before the current block", () => {
  const text = [
    ":base = https://one.example",
    "# first",
    "GET :base/a",
    "# vars changed later",
    ":base = https://two.example",
    "# second",
    "GET :base/b",
  ].join("\n")

  expect(parseRequestAt(text, text.indexOf("/a"))?.url).toBe("https://one.example/a")
  expect(parseRequestAt(text, text.indexOf("/b"))?.url).toBe("https://two.example/b")
})

test("parseRequestAt uses variables earlier in the same block before the request line", () => {
  const text = ":base = https://same-block.example\nGET :base/ok\n"
  expect(parseRequestAt(text, text.indexOf("GET"))?.url).toBe("https://same-block.example/ok")
})

test("parseRequestAt returns null for a variable/comment-only block", () => {
  const text = ":base = https://example.test\n# notes\nnot a request\n# request\nGET :base/ok\n"
  expect(parseRequestAt(text, text.indexOf("not a request"))).toBeNull()
})

test("buildCurlInvocation constructs argv without spawning", () => {
  const req = parseRequestAt([
    "PUT https://example.test/items/1",
    "Accept: application/json",
    "",
    "{\"ok\":true}",
  ].join("\n"), 0)!

  expect(buildCurlInvocation(req)).toEqual({
    cmd: [
      "curl",
      "-sS",
      "-i",
      "-X",
      "PUT",
      "-H",
      "Accept: application/json",
      "--data-binary",
      "@-",
      "https://example.test/items/1",
    ],
    stdin: "{\"ok\":true}",
  })
})

test("buildCurlInvocation omits stdin for bodyless requests", () => {
  const req = parseRequestAt("GET https://example.test\nAccept: text/plain\n", 0)!
  expect(buildCurlInvocation(req)).toEqual({
    cmd: ["curl", "-sS", "-i", "-X", "GET", "-H", "Accept: text/plain", "https://example.test"],
    stdin: null,
  })
})

test("requestStarts and jump helpers skip comment separators", () => {
  const text = "# one\nGET https://one.test\n# two\nPOST https://two.test\n\nbody\n# three\nDELETE https://three.test\n"
  const starts = requestStarts(text)
  expect(starts).toEqual([
    text.indexOf("GET"),
    text.indexOf("POST"),
    text.indexOf("DELETE"),
  ])
  expect(nextRequestPoint(text, starts[0]!)).toBe(starts[1])
  expect(nextRequestPoint(text, starts[2]!)).toBeNull()
  expect(previousRequestPoint(text, starts[2]!)).toBe(starts[1])
  expect(previousRequestPoint(text, starts[0]!)).toBeNull()
})

test("install registers commands and restclient mode bindings", () => {
  const editor = makeEditor()
  install(editor)

  expect(editor.commands.get("restclient-http-send-current")).toBeDefined()
  expect(editor.commands.get("restclient-http-send-current-raw")).toBeDefined()
  expect(editor.commands.get("restclient-jump-next")).toBeDefined()
  expect(editor.commands.get("restclient-jump-previous")).toBeDefined()
  expect(getMode("restclient")?.keymap?.get("C-c C-c")).toBe("restclient-http-send-current")
  expect(getMode("restclient")?.keymap?.get("C-c C-r")).toBe("restclient-http-send-current-raw")
  expect(getMode("restclient")?.keymap?.get("C-c C-n")).toBe("restclient-jump-next")
  expect(getMode("restclient")?.keymap?.get("C-c C-p")).toBe("restclient-jump-previous")
})

test("restclient commands use injected spawn and pretty-print JSON responses", async () => {
  const editor = makeEditor()
  const { spawn, calls, stdin } = fakeSpawn([
    "HTTP/1.1 200 OK",
    "Content-Type: application/json",
    "",
    "{\"answer\":42}",
  ].join("\r\n"))
  install(editor, { spawn })

  editor.scratch("api.http", "POST https://example.test\nContent-Type: application/json\n\n{\"q\":1}\n", "restclient")
  await editor.run("restclient-http-send-current")

  expect(calls).toHaveLength(1)
  expect(calls[0]?.cmd).toEqual([
    "curl",
    "-sS",
    "-i",
    "-X",
    "POST",
    "-H",
    "Content-Type: application/json",
    "--data-binary",
    "@-",
    "https://example.test",
  ])
  expect(stdin).toEqual(["{\"q\":1}"])
  expect(editor.currentBuffer.name).toBe("*HTTP Response*")
  expect(editor.currentBuffer.text).toBe([
    "HTTP/1.1 200 OK",
    "Content-Type: application/json",
    "",
    "{",
    "  \"answer\": 42",
    "}",
    "",
  ].join("\r\n"))
})

test("raw send leaves JSON body unchanged", async () => {
  const editor = makeEditor()
  const { spawn } = fakeSpawn("HTTP/1.1 200 OK\nContent-Type: application/json\n\n{\"answer\":42}")
  install(editor, { spawn })

  editor.scratch("api.http", "GET https://example.test\n", "restclient")
  await editor.run("restclient-http-send-current-raw")

  expect(editor.currentBuffer.text).toBe("HTTP/1.1 200 OK\nContent-Type: application/json\n\n{\"answer\":42}")
})

test("formatHttpResponse leaves non-json and invalid json bodies untouched", () => {
  const html = "HTTP/1.1 200 OK\nContent-Type: text/html\n\n<p>ok</p>"
  const invalid = "HTTP/1.1 200 OK\nContent-Type: application/json\n\nnot json"
  expect(formatHttpResponse(html, true)).toBe(html)
  expect(formatHttpResponse(invalid, true)).toBe(invalid)
})
