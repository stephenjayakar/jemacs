import { expect, test } from "bun:test"
import { BufferModel, type SerializedUndoTree } from "../src/kernel/buffer"

type ChangeEvent = { start: number; end: number; text: string }

test("undo and redo fire onTextChange", () => {
  const b = new BufferModel({ name: "x", text: "hello" })
  const events: ChangeEvent[] = []
  b.onTextChange = e => events.push(e)
  b.point = 5
  b.insert(" world")
  events.length = 0

  b.undo()
  expect(b.text).toBe("hello")
  // op-log undo: per-op delta, not full-replace — better for incremental LSP sync.
  expect(events).toEqual([{ start: 5, end: 11, text: "" }])

  events.length = 0
  b.redo()
  expect(b.text).toBe("hello world")
  expect(events).toEqual([{ start: 5, end: 5, text: " world" }])
})

test("undo across multiple edits restores correct point", () => {
  const b = new BufferModel({ name: "x", text: "abc" })
  b.point = 3
  b.insert("XYZ")
  b.insert("123")
  expect(b.text).toBe("abcXYZ123")
  expect(b.point).toBe(9)

  b.undo()
  expect(b.text).toBe("abcXYZ")
  expect(b.point).toBe(6)

  b.undo()
  expect(b.text).toBe("abc")
  expect(b.point).toBe(3)
  expect(b.point).toBeLessThanOrEqual(b.text.length)
})

test("redo after new edit clears redo stack", () => {
  const b = new BufferModel({ name: "x", text: "one" })
  b.point = 3
  b.insert(" two")
  b.undo()
  expect(b.text).toBe("one")

  b.insert(" three")
  expect(b.text).toBe("one three")

  b.redo()
  expect(b.text).toBe("one three")
})

test("undo tree records timestamps", () => {
  const originalNow = Date.now
  try {
    Date.now = () => 1000
    const b = new BufferModel({ name: "x", text: "one" })
    Date.now = () => 2000
    b.point = 3
    b.insert(" two")

    const snapshot = b.undoTreeSnapshot()
    expect(snapshot.root.at).toBe(1000)
    expect(snapshot.root.children[0]!.at).toBe(2000)
    expect(snapshot.current.at).toBe(2000)
  } finally {
    Date.now = originalNow
  }
})

test("edit after undo creates selected branch but older branch remains reachable", () => {
  const b = new BufferModel({ name: "x", text: "one" })
  b.point = 3
  b.insert(" two")
  b.undo()
  b.point = 3
  b.insert(" three")
  expect(b.text).toBe("one three")

  b.undo()
  expect(b.undoBranchCount()).toBe(2)
  expect(b.undoSetBranch(0, 0)).toBe(true)
  b.redo()
  expect(b.text).toBe("one two")
})

test("undoToNode can jump across undo branches", () => {
  const b = new BufferModel({ name: "x", text: "one" })
  b.point = 3
  b.insert(" two")
  const branchA = b.seq
  b.undo()
  b.point = 3
  b.insert(" three")
  const branchB = b.seq
  expect(b.text).toBe("one three")

  expect(b.undoToNode(branchA)).toBe(true)
  expect(b.text).toBe("one two")

  expect(b.undoToNode(branchB)).toBe(true)
  expect(b.text).toBe("one three")
})

test("undo tree serialization round-trips branches", () => {
  const b = new BufferModel({ name: "x", text: "one" })
  b.point = 3
  b.insert(" two")
  const abandoned = b.seq
  b.undo()
  b.point = 3
  b.insert(" three")
  const current = b.seq
  b.markSaved()

  const serialized = b.undoTreeSerialize()
  const restored = new BufferModel({ name: "x", text: b.text })
  expect(restored.undoTreeRestore(serialized)).toBe(true)
  expect(restored.undoTreeSnapshot()).toEqual(b.undoTreeSnapshot())
  expect(restored.dirty).toBe(false)

  restored.undo()
  expect(restored.text).toBe("one")
  expect(restored.undoBranchCount()).toBe(2)
  expect(restored.undoSetBranch(0, 0)).toBe(true)
  restored.redo()
  expect(restored.text).toBe("one two")

  expect(restored.undoToNode(current)).toBe(true)
  expect(restored.text).toBe("one three")
  expect(restored.undoToNode(abandoned)).toBe(true)
  expect(restored.text).toBe("one two")
})

test("undo tree restore rejects text mismatch", () => {
  const b = new BufferModel({ name: "x", text: "one" })
  b.insert("!")
  const serialized = b.undoTreeSerialize()
  const restored = new BufferModel({ name: "x", text: "different" })

  expect(restored.undoTreeRestore(serialized)).toBe(false)
  expect(restored.undoTreeSnapshot().root.children).toEqual([])
})

test("undo tree restore rejects wrong version", () => {
  const b = new BufferModel({ name: "x", text: "one" })
  const serialized = { ...b.undoTreeSerialize(), version: 2 } as unknown as SerializedUndoTree

  expect(b.undoTreeRestore(serialized)).toBe(false)
})

test("undo in read-only buffer is no-op", () => {
  const b = new BufferModel({ name: "x", text: "locked" })
  b.readOnly = true
  const events: ChangeEvent[] = []
  b.onTextChange = e => events.push(e)

  expect(() => b.undo()).not.toThrow()
  expect(b.text).toBe("locked")
  expect(b.point).toBe(0)
  expect(events).toEqual([])
})

test("undo-limit drops the oldest history but keeps recent changes", () => {
  const b = new BufferModel({ name: "x", text: "" })
  const big = "x".repeat(10000)
  for (let i = 0; i < 100; i++) b.setText(`${i}${big}`, false)
  // 100 redraws × ~20 KB each would be ~2 MB without a cap.
  let depth = 0
  for (let n = b.undoTreeSnapshot().root; n.children.length; n = n.children[0]!) depth++
  expect(depth).toBeLessThan(20)
  expect(depth).toBeGreaterThan(0)
  b.undo()
  expect(b.text).toBe(`98${big}`)
})

test("undo-limit keeps a single change larger than the limit", () => {
  const b = new BufferModel({ name: "x", text: "" })
  b.insert("y".repeat(500000))
  b.undo()
  expect(b.text).toBe("")
})

test("undo-outer-limit drops a single change that is too large", () => {
  const b = new BufferModel({ name: "x", text: "" })
  b.insert("y".repeat(25000000))
  b.undo()
  expect(b.text.length).toBe(25000000)
})

test("truncation of the saved node keeps the buffer dirty after undo", () => {
  const b = new BufferModel({ name: "x", text: "" })
  b.markSaved()
  for (let i = 0; i < 40; i++) b.setText(`${i}${"z".repeat(10000)}`, true)
  b.undo()
  expect(b.dirty).toBe(true)
})

test("a truncated undo tree round-trips through serialization", () => {
  const b = new BufferModel({ name: "x", text: "" })
  for (let i = 0; i < 40; i++) b.setText(`${i}${"z".repeat(10000)}`, true)
  const restored = new BufferModel({ name: "x", text: b.text })
  expect(restored.undoTreeRestore(b.undoTreeSerialize())).toBe(true)
  restored.undo()
  expect(restored.text.startsWith("38")).toBe(true)
})
