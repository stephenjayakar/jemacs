import { expect, test } from "bun:test"
import { join } from "node:path"
import {
  buildModeInventory,
  extractInferModeRoutes,
  extractModeDefinitions,
  generateMarkdownReport,
} from "../scripts/mode-inventory"

const root = join(import.meta.dirname, "..")

test("mode inventory extracts registered mode names from the real tree", () => {
  const modes = extractModeDefinitions(root)
  const names = new Set(modes.map(mode => mode.name))

  expect(names.has("css-mode")).toBe(true)
  expect(names.has("toml-mode")).toBe(true)
  expect(names.has("xml-mode")).toBe(true)
  expect(names.has("comint-mode")).toBe(true)
  expect(names.has("shell-mode")).toBe(true)
})

test("mode inventory extracts inferMode regex routes", () => {
  const routes = extractInferModeRoutes(root)

  expect(routes.some(route => route.pattern === "/\\.css$/" && route.mode === "css-mode")).toBe(true)
  expect(routes.some(route => route.pattern === "/\\.toml$/" && route.mode === "toml-mode")).toBe(true)
  expect(routes.some(route => route.pattern.includes("xml|svg|xhtml") && route.mode === "xml-mode")).toBe(true)
})

test("mode inventory generates a markdown report", () => {
  const inventory = buildModeInventory(root)
  const report = generateMarkdownReport(inventory)

  expect(inventory.implementedGnuModes).toContain("css-mode")
  expect(inventory.implementedGnuModes).toContain("toml-mode")
  expect(inventory.implementedGnuModes).toContain("xml-mode")
  expect(report).toContain("# Jemacs Mode Inventory")
  expect(report).toContain("## Implemented GNU Modes")
  expect(report).toContain("## Missing GNU Modes")
  expect(report).toContain("## Jemacs-Only Modes")
  expect(report).toContain("## Extensions Routed")
})
