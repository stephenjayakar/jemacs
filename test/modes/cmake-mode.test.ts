import { expect, test } from "bun:test"
import { BufferModel } from "../../src/kernel/buffer"
import { cmakeFontLock, cmakeIndentLine, installCmakeMode } from "../../src/modes/cmake"
import { getMode, modeFeature, type TextSpan } from "../../src/modes/mode"

function expectSpan(text: string, spans: TextSpan[], needle: string, face: TextSpan["face"], from = 0): void {
  const start = text.indexOf(needle, from)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(spans).toContainEqual({ start, end: start + needle.length, face })
}

test("cmake-mode installs a prog-mode child with CMake comments", () => {
  installCmakeMode()

  expect(getMode("cmake-mode")?.parent).toBe("prog-mode")
  expect(getMode("cmake-mode")?.commentStart).toBe("#")
  expect(modeFeature("cmake-mode", "fontLock")).toBe(cmakeFontLock)
  expect(modeFeature("cmake-mode", "indentLine")).toBe(cmakeIndentLine)
})

test("cmake-mode font-lock highlights commands, variables, arguments, strings, and comments", () => {
  installCmakeMode()
  const text = [
    "# project build",
    "cmake_minimum_required(VERSION 3.26)",
    "project(Jemacs)",
    "add_library(core STATIC src/core.cc)",
    "target_link_libraries(core PUBLIC ${OPENSSL_LIBRARIES})",
    "set(OUTPUT \"${CMAKE_BINARY_DIR}/jemacs\")",
    "custom_command(OUTPUT generated.cc)",
    "message(\"building ${PROJECT_NAME}\") # status",
    "if(ENABLE_TESTS)",
    "  add_subdirectory(test)",
    "endif()",
  ].join("\n")
  const buffer = new BufferModel({ name: "CMakeLists.txt", text, mode: "cmake-mode" })
  const spans = cmakeFontLock(buffer)

  expectSpan(text, spans, "# project build", "comment")
  expectSpan(text, spans, "cmake_minimum_required", "keyword")
  expectSpan(text, spans, "project", "keyword", text.indexOf("project(Jemacs)"))
  expectSpan(text, spans, "add_library", "keyword")
  expectSpan(text, spans, "STATIC", "keyword")
  expectSpan(text, spans, "target_link_libraries", "keyword")
  expectSpan(text, spans, "PUBLIC", "keyword")
  expectSpan(text, spans, "${OPENSSL_LIBRARIES}", "builtin")
  expectSpan(text, spans, "set", "keyword")
  expectSpan(text, spans, "\"${CMAKE_BINARY_DIR}/jemacs\"", "string")
  expectSpan(text, spans, "${CMAKE_BINARY_DIR}", "builtin")
  expectSpan(text, spans, "custom_command", "function")
  expectSpan(text, spans, "message", "keyword")
  expectSpan(text, spans, "${PROJECT_NAME}", "builtin")
  expectSpan(text, spans, "# status", "comment")
  expectSpan(text, spans, "if", "keyword")
  expectSpan(text, spans, "add_subdirectory", "keyword")
  expectSpan(text, spans, "endif", "keyword")

  const ranged = cmakeFontLock(buffer, { startLine: 2, endLine: 5, start: buffer.lineStarts[2]!, end: buffer.lineStarts[5]! })
  expect(ranged.some(span => text.slice(span.start, span.end) === "# project build")).toBe(false)
  expectSpan(text, ranged, "project", "keyword", text.indexOf("project(Jemacs)"))
  expectSpan(text, ranged, "add_library", "keyword")
  expectSpan(text, ranged, "PUBLIC", "keyword")
})

test("cmake-mode indentation uses two spaces inside block commands", () => {
  installCmakeMode()
  const buffer = new BufferModel({
    name: "CMakeLists.txt",
    text: [
      "if(ENABLE)",
      "message(\"on\")",
      "  else()",
      "message(\"off\")",
      "  endif()",
      "function(build)",
      "foreach(src IN LISTS SRCS)",
      "add_executable(app ${src})",
      "endforeach()",
      "endfunction()",
    ].join("\n"),
    mode: "cmake-mode",
  })

  buffer.point = buffer.text.indexOf("message(\"on\")")
  cmakeIndentLine(buffer)
  expect(buffer.text).toContain("if(ENABLE)\n  message(\"on\")\n")

  buffer.point = buffer.text.indexOf("else")
  cmakeIndentLine(buffer)
  expect(buffer.text).toContain("  message(\"on\")\nelse()\n")

  buffer.point = buffer.text.indexOf("message(\"off\")")
  cmakeIndentLine(buffer)
  expect(buffer.text).toContain("else()\n  message(\"off\")\n")

  buffer.point = buffer.text.indexOf("endif")
  cmakeIndentLine(buffer)
  expect(buffer.text).toContain("  message(\"off\")\nendif()\n")

  buffer.point = buffer.text.indexOf("add_executable")
  cmakeIndentLine(buffer)
  expect(buffer.text).toContain("foreach(src IN LISTS SRCS)\n    add_executable(app ${src})\n")

  buffer.point = buffer.text.indexOf("endforeach")
  cmakeIndentLine(buffer)
  expect(buffer.text).toContain("    add_executable(app ${src})\n  endforeach()\n")
})
