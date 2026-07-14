import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { ContentLengthMessageParser, serializeContentLength } from "../src/protocol/content-length"
import { DapConnection } from "../src/dap/connection"
import { expandLaunchConfiguration, parseLaunchJson, resolveCompound, stripJsonComments, stripTrailingCommas, visibleLaunchItems } from "../src/dap/config"
import { DapSession } from "../src/dap/session"
import type { DapMessage, JdapContext, JdapLaunchConfiguration } from "../src/dap/types"
import { Editor } from "../src/kernel/editor"

describe("Content-Length protocol framing", () => {
  test("parses fragmented and adjacent UTF-8 messages", () => {
    const parser = new ContentLengthMessageParser<{ value: string }>()
    const first = serializeContentLength({ value: "héllo" })
    const second = serializeContentLength({ value: "world" })
    expect(parser.feed(first.slice(0, 9))).toEqual([])
    expect(parser.feed(first.slice(9) + second)).toEqual([{ value: "héllo" }, { value: "world" }])
  })
})

describe("DAP connection", () => {
  test("matches responses and answers reverse requests", async () => {
    const sent: string[] = []
    const parser = new ContentLengthMessageParser<DapMessage>()
    const connection = new DapConnection(payload => sent.push(payload))
    let reverse = false
    connection.onRequest(request => {
      reverse = true
      connection.respond(request, { processId: 7 })
    })
    const resultPromise = connection.request("threads")
    const request = parser.feed(sent.shift()!)[0]!
    expect(request.type).toBe("request")
    connection.feed(serializeContentLength({
      seq: 1,
      type: "response",
      request_seq: request.seq,
      command: "threads",
      success: true,
      body: { threads: [{ id: 1, name: "main" }] },
    }))
    expect(await resultPromise).toEqual({ threads: [{ id: 1, name: "main" }] })
    connection.feed(serializeContentLength({ seq: 2, type: "request", command: "runInTerminal", arguments: {} }))
    await Promise.resolve()
    expect(reverse).toBe(true)
    const response = parser.feed(sent.shift()!)[0]!
    expect(response.type).toBe("response")
    if (response.type === "response") expect(response.body).toEqual({ processId: 7 })
  })
})

describe("VS Code launch.json", () => {
  const context: JdapContext = {
    projectRoot: "/work/app",
    workspaceFolders: { app: "/work/app" },
    file: "/work/app/src/main.py",
    cwd: "/work/app/src",
    env: name => name === "PORT" ? "9000" : undefined,
    configValues: { flavor: "dev" },
  }

  test("parses JSONC and keeps comma-like string contents", () => {
    const text = `{
      // comment
      "version": "0.2.0",
      "configurations": [{
        "name": "Python,}",
        "type": "debugpy",
        "request": "launch",
        "program": "${"${file}"}",
      },],
      "compounds": [{ "name": "All", "configurations": ["Python,}"], }],
    }`
    expect(stripJsonComments(text)).not.toContain("// comment")
    expect(stripTrailingCommas(stripJsonComments(text))).toContain('"Python,}"')
    const launch = parseLaunchJson(text)
    expect(launch.configurations[0]!.name).toBe("Python,}")
    expect(resolveCompound(launch, "All").configurations).toHaveLength(1)
  })

  test("sorts presentation entries and expands nested VS Code variables and inputs", async () => {
    const launch = parseLaunchJson(`{
      "version": "0.2.0",
      "configurations": [
        { "name": "Later", "type": "debugpy", "request": "launch", "presentation": { "group": "g", "order": 2 } },
        { "name": "First", "type": "debugpy", "request": "launch", "presentation": { "group": "g", "order": 1 } },
        { "name": "Hidden", "type": "debugpy", "request": "launch", "presentation": { "hidden": true } }
      ],
      "inputs": [{ "id": "pick", "type": "pickString", "options": ["one", "two"], "default": "two" }]
    }`)
    expect(visibleLaunchItems(launch).map(item => item.name)).toEqual(["First", "Later"])
    const editor = new Editor()
    editor.completingRead = async () => "two"
    const config: JdapLaunchConfiguration = {
      name: "expanded",
      type: "debugpy",
      request: "launch",
      program: "${file}",
      cwd: "${workspaceFolder}",
      args: ["${relativeFile}", "${env:PORT}", "${config:flavor}", "${input:pick}"],
    }
    expect(await expandLaunchConfiguration(editor, config, launch, context)).toMatchObject({
      program: "/work/app/src/main.py",
      cwd: "/work/app",
      args: ["src/main.py", "9000", "dev", "two"],
    })
  })
})

describe("DAP session", () => {
  test("runs initialization, stopped-state inspection, evaluation, and shutdown", async () => {
    const fixture = join(import.meta.dir, "fixtures", "fake-dap-adapter.ts")
    let changes = 0
    const session = new DapSession("fake", {
      name: "fake",
      type: "fake",
      request: "launch",
      program: "/tmp/fake.ts",
    }, {
      kind: "stdio",
      command: [process.execPath, fixture],
    }, {
      breakpoints: () => [{ id: "bp", path: "/tmp/fake.ts", line: 4, enabled: true }],
      changed: () => { changes++ },
    })
    await session.start()
    expect(session.state).toBe("running")
    expect(session.threads).toEqual([{ id: 1, name: "main" }])
    await session.pause()
    for (let i = 0; i < 50 && !session.selectedFrame; i++) await Bun.sleep(10)
    expect(session.state).toBe("stopped")
    expect(session.selectedFrame?.line).toBe(4)
    expect(session.scopes[0]?.variables[0]?.value).toBe("42")
    expect((await session.evaluate("answer")).result).toBe("42")
    await session.continue()
    expect(session.state).toBe("running")
    await session.disconnect()
    expect(session.state).toBe("terminated")
    expect(changes).toBeGreaterThan(3)
  })
})
