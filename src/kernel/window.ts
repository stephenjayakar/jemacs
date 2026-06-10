export type WindowId = string

export type WindowLeaf = {
  kind: "leaf"
  id: WindowId
  bufferId: string
  point: number
  startLine: number
  dedicated: boolean
}

export type WindowSplit = {
  kind: "split"
  direction: "horizontal" | "vertical"
  firstRatio?: number
  first: WindowNode
  second: WindowNode
}

export type WindowNode = WindowLeaf | WindowSplit

export type ChildFrameParameters = Record<string, unknown>

export type ChildFrameRecord = {
  id: string
  parentFrameId: WindowId
  window: WindowLeaf
  parameters: ChildFrameParameters
  visible: boolean
}

export function createLeafWindow(bufferId: string, point = 0, id = crypto.randomUUID(), startLine = 0): WindowLeaf {
  return { kind: "leaf", id, bufferId, point, startLine, dedicated: false }
}

export function cloneWindowNode(node: WindowNode): WindowNode {
  if (node.kind === "leaf") return { ...node }
  return {
    kind: "split",
    direction: node.direction,
    firstRatio: node.firstRatio,
    first: cloneWindowNode(node.first),
    second: cloneWindowNode(node.second),
  }
}

export function findWindowShowingBuffer(node: WindowNode, bufferId: string, excludeId?: WindowId): WindowLeaf | null {
  for (const leaf of listWindowLeaves(node)) {
    if (leaf.bufferId === bufferId && leaf.id !== excludeId && !leaf.dedicated) return leaf
  }
  return null
}

export function pickReusableWindow(node: WindowNode, selectedId: WindowId): WindowLeaf | null {
  return listWindowLeaves(node).find(leaf => leaf.id !== selectedId && !leaf.dedicated) ?? null
}

export function listWindowLeaves(node: WindowNode): WindowLeaf[] {
  if (node.kind === "leaf") return [node]
  return [...listWindowLeaves(node.first), ...listWindowLeaves(node.second)]
}

export function windowLeafCount(node: WindowNode): number {
  if (node.kind === "leaf") return 1
  return windowLeafCount(node.first) + windowLeafCount(node.second)
}

export function findWindowLeaf(node: WindowNode, id: WindowId): WindowLeaf | null {
  if (node.kind === "leaf") return node.id === id ? node : null
  return findWindowLeaf(node.first, id) ?? findWindowLeaf(node.second, id)
}

export function mapWindowLeaves(node: WindowNode, fn: (leaf: WindowLeaf) => WindowLeaf): WindowNode {
  if (node.kind === "leaf") return fn(node)
  return {
    kind: "split",
    direction: node.direction,
    firstRatio: node.firstRatio,
    first: mapWindowLeaves(node.first, fn),
    second: mapWindowLeaves(node.second, fn),
  }
}

export type SplitResult = { layout: WindowNode; newWindowId: WindowId; found: boolean }

export function splitWindowLeaf(
  node: WindowNode,
  id: WindowId,
  direction: WindowSplit["direction"],
  bufferId: string,
  point: number,
): SplitResult {
  if (node.kind === "leaf") {
    if (node.id !== id) return { layout: node, newWindowId: id, found: false }
    // Original leaf stays first (left/top) and keeps its id; the fresh leaf
    // goes second (right/bottom) and inherits the original's viewport.
    const newLeaf: WindowLeaf = {
      kind: "leaf",
      id: crypto.randomUUID(),
      bufferId,
      point,
      startLine: node.startLine,
      dedicated: false,
    }
    return {
      layout: { kind: "split", direction, first: node, second: newLeaf },
      newWindowId: newLeaf.id,
      found: true,
    }
  }
  const inFirst = splitWindowLeaf(node.first, id, direction, bufferId, point)
  if (inFirst.found) {
    return {
      layout: { kind: "split", direction: node.direction, firstRatio: node.firstRatio, first: inFirst.layout, second: node.second },
      newWindowId: inFirst.newWindowId,
      found: true,
    }
  }
  const inSecond = splitWindowLeaf(node.second, id, direction, bufferId, point)
  if (inSecond.found) {
    return {
      layout: { kind: "split", direction: node.direction, firstRatio: node.firstRatio, first: node.first, second: inSecond.layout },
      newWindowId: inSecond.newWindowId,
      found: true,
    }
  }
  return { layout: node, newWindowId: id, found: false }
}

export function deleteWindowLeaf(node: WindowNode, id: WindowId): WindowNode | null {
  if (node.kind === "leaf") return node.id === id ? null : node
  const first = deleteWindowLeaf(node.first, id)
  const second = deleteWindowLeaf(node.second, id)
  if (first == null) return second
  if (second == null) return first
  return { kind: "split", direction: node.direction, firstRatio: node.firstRatio, first, second }
}

export function deleteOtherWindowLeaves(node: WindowNode, id: WindowId): WindowNode {
  const keep = findWindowLeaf(node, id)
  if (!keep) throw new Error(`No such window: ${id}`)
  return keep
}

export function nextWindowId(node: WindowNode, currentId: WindowId, delta = 1): WindowId {
  const leaves = listWindowLeaves(node)
  if (!leaves.length) throw new Error("No windows")
  const index = leaves.findIndex(leaf => leaf.id === currentId)
  const currentIndex = index === -1 ? 0 : index
  const nextIndex = ((currentIndex + delta) % leaves.length + leaves.length) % leaves.length
  return leaves[nextIndex]!.id
}

export function nextEligibleWindowId(
  node: WindowNode,
  currentId: WindowId,
  delta: number,
  predicate: (leaf: WindowLeaf) => boolean,
): WindowId | null {
  const leaves = listWindowLeaves(node).filter(predicate)
  if (!leaves.length) return null
  const index = leaves.findIndex(leaf => leaf.id === currentId)
  const currentIndex = index === -1 ? 0 : index
  const next = leaves[(currentIndex + delta + leaves.length) % leaves.length]!
  return next.id === currentId ? null : next.id
}

export function setWindowLeafBuffer(node: WindowNode, id: WindowId, bufferId: string, point: number): WindowNode {
  return mapWindowLeaves(node, leaf => leaf.id === id ? { ...leaf, bufferId, point } : leaf)
}

export function setWindowLeafPoint(node: WindowNode, id: WindowId, point: number): WindowNode {
  return mapWindowLeaves(node, leaf => leaf.id === id ? { ...leaf, point } : leaf)
}

export function setWindowLeafStartLine(node: WindowNode, id: WindowId, startLine: number): WindowNode {
  return mapWindowLeaves(node, leaf => leaf.id === id ? { ...leaf, startLine } : leaf)
}

export function setWindowLeafDedicated(node: WindowNode, id: WindowId, dedicated: boolean): WindowNode {
  return mapWindowLeaves(node, leaf => leaf.id === id ? { ...leaf, dedicated } : leaf)
}

export function scrollWindowLeaf(node: WindowNode, id: WindowId, lineDelta: number, maxStartLine: number): WindowNode {
  return mapWindowLeaves(node, leaf => {
    if (leaf.id !== id) return leaf
    return { ...leaf, startLine: Math.max(0, Math.min(maxStartLine, leaf.startLine + lineDelta)) }
  })
}

export function removeBufferFromWindows(node: WindowNode, bufferId: string, fallbackBufferId: string): WindowNode {
  return mapWindowLeaves(node, leaf => leaf.bufferId === bufferId
    ? { ...leaf, bufferId: fallbackBufferId, point: 0 }
    : leaf)
}

export function balanceWindowTree(node: WindowNode): WindowNode {
  if (node.kind === "leaf") return node
  const first = balanceWindowTree(node.first)
  const second = balanceWindowTree(node.second)
  const total = windowLeafCount(first) + windowLeafCount(second)
  return {
    kind: "split",
    direction: node.direction,
    firstRatio: total <= 0 ? 0.5 : windowLeafCount(first) / total,
    first,
    second,
  }
}
