import { reactive } from "vue"
import { createUuid } from "@/lib/uuid"

export type SplitDirection = "horizontal" | "vertical"

export interface PaneLeaf {
  kind: "leaf"
  id: string
  runtimeId: string
}

export interface PaneGroup {
  kind: "group"
  id: string
  /** horizontal means side-by-side panes with a vertical divider; vertical means stacked panes with a horizontal divider. */
  direction: SplitDirection
  children: PaneNode[]
  /** Percentages retained on every group so the layout can be restored after remounting. */
  sizes?: number[]
}

export type PaneNode = PaneLeaf | PaneGroup

export interface SplitRestoreAction {
  leafId: string
  runtimeId: string
}

/** Module-level split state deliberately outlives the layout component. */
export const splitView = reactive<{
  tree: PaneNode | null
  /** Retained while another non-member conversation is shown full-screen. */
  suspendedTree: PaneNode | null
}>({
  tree: null,
  suspendedTree: null,
})

const createLeaf = (runtimeId: string): PaneLeaf => ({ kind: "leaf", id: createUuid(), runtimeId })

const createPair = (primaryRuntimeId: string, secondaryRuntimeId: string, direction: SplitDirection): PaneGroup => ({
  kind: "group",
  id: createUuid(),
  direction,
  children: [createLeaf(primaryRuntimeId), createLeaf(secondaryRuntimeId)],
  sizes: [50, 50],
})

function findLeaf(node: PaneNode | null, leafId: string): PaneLeaf | null {
  if (!node) return null
  if (node.kind === "leaf") return node.id === leafId ? node : null
  for (const child of node.children) {
    const leaf = findLeaf(child, leafId)
    if (leaf) return leaf
  }
  return null
}

function collectRuntimeIds(node: PaneNode | null, ids: Set<string>) {
  if (!node) return
  if (node.kind === "leaf") {
    ids.add(node.runtimeId)
    return
  }
  for (const child of node.children) collectRuntimeIds(child, ids)
}

function collapseSingleChildGroups(node: PaneNode): PaneNode {
  if (node.kind === "leaf") return node
  const children = node.children.map(collapseSingleChildGroups)
  node.children = children
  return children.length === 1 ? children[0]! : node
}

/** Show two conversations, replacing any previous split and any suspended layout. */
export function enterSplit(primaryRuntimeId: string, secondaryRuntimeId: string, direction: SplitDirection) {
  splitView.tree = createPair(primaryRuntimeId, secondaryRuntimeId, direction)
  splitView.suspendedTree = null
}

/**
 * Insert a new pane beside the target leaf. A left/right zone creates a nested
 * horizontal group, while top/bottom creates a nested vertical group.
 */
export function insertAdjacent(targetLeafId: string, zone: "left" | "right" | "top" | "bottom", newRuntimeId: string) {
  const target = findLeaf(splitView.tree, targetLeafId)
  if (!target) return

  const nested: PaneGroup = {
    kind: "group",
    id: createUuid(),
    direction: zone === "left" || zone === "right" ? "horizontal" : "vertical",
    children:
      zone === "left" || zone === "top" ? [createLeaf(newRuntimeId), target] : [target, createLeaf(newRuntimeId)],
    sizes: [50, 50],
  }

  function replaceCurrent(node: PaneNode): PaneNode {
    if (node.kind === "leaf") return node.id === targetLeafId ? nested : node
    node.children = node.children.map(replaceCurrent)
    return node
  }
  if (splitView.tree) splitView.tree = replaceCurrent(splitView.tree)
}

/** Point an existing pane at another runtime without changing the tree shape. */
export function replaceLeaf(leafId: string, runtimeId: string) {
  const leaf = findLeaf(splitView.tree, leafId)
  if (leaf) leaf.runtimeId = runtimeId
}

/** Remove a leaf, then recursively collapse every group left with one child. */
export function closePane(leafId: string) {
  function removeFrom(node: PaneNode): PaneNode | null {
    if (node.kind === "leaf") return node.id === leafId ? null : node
    const children = node.children.flatMap(child => {
      const next = removeFrom(child)
      return next ? [next] : []
    })
    if (children.length === 0) return null
    node.children = children
    return node
  }

  if (!splitView.tree) return
  const next = removeFrom(splitView.tree)
  splitView.tree = next ? collapseSingleChildGroups(next) : null
}

/** Membership includes a suspended tree so its runtimes remain prune-exempt. */
export function isMember(runtimeId: string) {
  return runtimeIds().has(runtimeId)
}

/** Locate a leaf by its conversation, within the active tree only. */
export function leafByRuntime(runtimeId: string): PaneLeaf | null {
  function find(node: PaneNode | null): PaneLeaf | null {
    if (!node) return null
    if (node.kind === "leaf") return node.runtimeId === runtimeId ? node : null
    for (const child of node.children) {
      const leaf = find(child)
      if (leaf) return leaf
    }
    return null
  }
  return find(splitView.tree)
}

/** First leaf of the active tree in visual order, for fallback activation. */
export function firstLeafRuntime(): string | null {
  let node = splitView.tree
  while (node?.kind === "group") node = node.children[0]
  return node?.runtimeId ?? null
}

/** Restore a retained split when a clicked conversation belongs to it. */
export function restoreIfMember(runtimeId: string): SplitRestoreAction | null {
  const source = splitView.tree ?? splitView.suspendedTree
  function findRuntime(node: PaneNode): PaneLeaf | null {
    if (node.kind === "leaf") return node.runtimeId === runtimeId ? node : null
    for (const child of node.children) {
      const leaf = findRuntime(child)
      if (leaf) return leaf
    }
    return null
  }

  const leaf = source ? findRuntime(source) : null
  if (!leaf) return null
  if (!splitView.tree && splitView.suspendedTree) {
    splitView.tree = splitView.suspendedTree
    splitView.suspendedTree = null
  }
  return { leafId: leaf.id, runtimeId }
}

/** Keep the split for later while a non-member conversation is displayed alone. */
export function suspend() {
  if (splitView.suspendedTree || !splitView.tree) return
  splitView.suspendedTree = splitView.tree
  splitView.tree = null
}

/** Runtime IDs from both active and suspended trees, for conversation pruning exemptions. */
export function runtimeIds(): Set<string> {
  const ids = new Set<string>()
  collectRuntimeIds(splitView.tree, ids)
  collectRuntimeIds(splitView.suspendedTree, ids)
  return ids
}

export function clear() {
  splitView.tree = null
  splitView.suspendedTree = null
}
