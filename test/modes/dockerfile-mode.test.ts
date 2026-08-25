import { expect, test } from "bun:test"
import { BufferModel } from "../../src/kernel/buffer"
import { dockerfileFontLock, dockerfileImenuIndex, installDockerfileMode } from "../../src/modes/dockerfile"
import { getMode, modeFeature, type TextSpan } from "../../src/modes/mode"

function expectSpan(text: string, spans: TextSpan[], needle: string, face: TextSpan["face"]): void {
  const start = text.indexOf(needle)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(spans).toContainEqual({ start, end: start + needle.length, face })
}

test("dockerfile-mode installs a prog-mode child with Dockerfile comments", () => {
  installDockerfileMode()

  expect(getMode("dockerfile-mode")?.parent).toBe("prog-mode")
  expect(getMode("dockerfile-mode")?.commentStart).toBe("#")
  expect(modeFeature("dockerfile-mode", "fontLock")).toBeDefined()
  expect(modeFeature("dockerfile-mode", "indentLine")).toBeDefined()
  expect(modeFeature("dockerfile-mode", "imenuIndex")).toBeDefined()
})

test("dockerfile-mode font-lock highlights comments, instructions, strings, variables, and continuations", () => {
  installDockerfileMode()
  const text = [
    "# syntax=docker/dockerfile:1",
    "FROM node:20 AS build",
    "ARG APP_HOME=/srv/app",
    "ENV PATH=\"/usr/local/bin\" \\",
    "    APP_HOME=${APP_HOME}",
    "RUN echo 'hello' && \\",
    "    echo ${APP_HOME} # show path",
    "COPY . ${APP_HOME}",
  ].join("\n")
  const buffer = new BufferModel({ name: "Dockerfile", text, mode: "dockerfile-mode" })
  const spans = dockerfileFontLock(buffer)

  expectSpan(text, spans, "# syntax=docker/dockerfile:1", "comment")
  expectSpan(text, spans, "FROM", "keyword")
  expectSpan(text, spans, "ARG", "keyword")
  expectSpan(text, spans, "ENV", "keyword")
  expectSpan(text, spans, "RUN", "keyword")
  expectSpan(text, spans, "COPY", "keyword")
  expectSpan(text, spans, "\"/usr/local/bin\"", "string")
  expectSpan(text, spans, "'hello'", "string")
  expectSpan(text, spans, "${APP_HOME}", "builtin")
  expectSpan(text, spans, "\\", "keyword")
  expectSpan(text, spans, "# show path", "comment")

  const ranged = dockerfileFontLock(buffer, { startLine: 1, endLine: 4, start: buffer.lineStarts[1]!, end: buffer.lineStarts[4]! })
  expect(ranged.some(span => text.slice(span.start, span.end) === "# syntax=docker/dockerfile:1")).toBe(false)
  expectSpan(text, ranged, "FROM", "keyword")
  expectSpan(text, ranged, "ENV", "keyword")
})

test("dockerfile-mode imenu indexes named FROM stages", () => {
  const text = [
    "FROM node:20 AS build",
    "RUN echo build",
    "FROM --platform=$BUILDPLATFORM alpine AS runtime",
    "FROM scratch",
  ].join("\n")
  const buffer = new BufferModel({ name: "Dockerfile", text, mode: "dockerfile-mode" })

  expect(dockerfileImenuIndex(buffer)).toEqual([
    { name: "build", point: text.indexOf("build") },
    { name: "runtime", point: text.indexOf("runtime") },
  ])
})

test("dockerfile-mode indentation aligns continuation lines and top-level instructions", () => {
  installDockerfileMode()
  const buffer = new BufferModel({ name: "Dockerfile", text: "RUN apk add \\\napk-tools\n  COPY . /app\n", mode: "dockerfile-mode" })
  const indentLine = modeFeature("dockerfile-mode", "indentLine")!

  buffer.point = buffer.text.indexOf("apk-tools")
  indentLine(buffer)
  expect(buffer.text).toContain("RUN apk add \\\n    apk-tools\n")

  buffer.point = buffer.text.indexOf("COPY")
  indentLine(buffer)
  expect(buffer.text).toContain("apk-tools\nCOPY . /app\n")
})
