import { test, expect } from "bun:test"
import { script, parseKey } from "../harness"
import { Keymap, KeymapStack } from "../../src/kernel/keymap"

test("global C-c exact does not shadow higher-priority mode C-c C-c prefix", async () => {
  await script({ plugins: false })
    .do(ed => {
      ed.command("cmd-a", () => {})
      ed.command("cmd-b", () => {})
      ed.defineKey("global", "C-c", "cmd-a")
      ed.defineKey("text", "C-c C-c", "cmd-b")
    })
    .mode("text")
    .expect.that(async ed => {
      const r = await ed.handleKey(parseKey("C-c"))
      expect(r.status).toBe("pending")
    })
    .done()
})

test("an eager exact binding runs before compatibility bindings under the same prefix", () => {
  const map = new Keymap("transient-prefix-test")
  map.bind("c c", "commit")
  map.bind("c", "open-commit-transient", { eager: true })
  const stack = new KeymapStack(() => [{ name: map.name, keymap: map }])

  expect(stack.feed({ name: "c", sequence: "c" })).toMatchObject({
    status: "matched",
    command: "open-commit-transient",
  })
})
