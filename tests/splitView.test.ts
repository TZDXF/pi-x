import { beforeEach, test, expect } from "vitest"
import {
  clear,
  enterSplit,
  splitAtEdge,
  insertAdjacent,
  closePane,
  replaceLeaf,
  suspend,
  restoreIfMember,
  isMember,
  runtimeIds,
  leafByRuntime,
  firstLeafRuntime,
  splitView,
} from "@/stores/splitView"
import type { PaneGroup, PaneLeaf } from "@/stores/splitView"

beforeEach(() => {
  clear()
})

const leafRuntimeIds = (node: PaneGroup | PaneLeaf) => {
  if (node.kind === "leaf") return [node.runtimeId]
  return node.children.flatMap(leafRuntimeIds)
}

test("enterSplit creates a sized pair and can replace a leaf runtime", () => {
  enterSplit("primary", "secondary", "horizontal")
  const tree = splitView.tree
  expect(tree?.kind).toBe("group")
  if (tree?.kind !== "group") return
  expect(tree.direction).toBe("horizontal")
  expect(tree.sizes).toEqual([50, 50])
  expect(leafRuntimeIds(tree)).toEqual(["primary", "secondary"])

  replaceLeaf(tree.children[0].id, "replacement")
  expect(leafRuntimeIds(tree)).toEqual(["replacement", "secondary"])
})

test("insertAdjacent nests the target leaf according to the drop zone", () => {
  enterSplit("primary", "secondary", "horizontal")
  const root = splitView.tree
  if (root?.kind !== "group") return
  const target = root.children[0]

  insertAdjacent(target.id, "left", "left-session")
  expect(root.children[0].kind).toBe("group")
  const leftGroup = root.children[0]
  if (leftGroup.kind !== "group") return
  expect(leftGroup.direction).toBe("horizontal")
  expect(leftGroup.sizes).toEqual([50, 50])
  expect(leafRuntimeIds(leftGroup)).toEqual(["left-session", "primary"])
  expect(leafRuntimeIds(root)).toEqual(["left-session", "primary", "secondary"])

  insertAdjacent(leftGroup.children[1].id, "top", "top-session")
  expect(leftGroup.children[1].kind).toBe("group")
  const topGroup = leftGroup.children[1]
  if (topGroup.kind !== "group") return
  expect(topGroup.direction).toBe("vertical")
  expect(leafRuntimeIds(topGroup)).toEqual(["top-session", "primary"])
})

test("closePane removes leaves and recursively collapses singleton groups", () => {
  enterSplit("one", "two", "horizontal")
  const root = splitView.tree
  if (root?.kind !== "group") return
  insertAdjacent(root.children[0].id, "top", "top-session")
  const grownRoot = splitView.tree
  if (grownRoot?.kind !== "group") return
  const leftGroup = grownRoot.children[0]
  if (leftGroup.kind !== "group") return

  closePane(leftGroup.children[0].id)
  expect(leafRuntimeIds(splitView.tree!)).toEqual(["one", "two"])

  closePane(splitView.tree!.kind === "group" ? splitView.tree!.children[0].id : "")
  expect(splitView.tree?.kind).toBe("leaf")
  if (splitView.tree?.kind !== "leaf") return
  expect(splitView.tree.runtimeId).toBe("two")

  closePane(splitView.tree.id)
  expect(splitView.tree).toBeNull()
})

test("closing every child except one in a nested group keeps the remaining leaf", () => {
  enterSplit("primary", "secondary", "horizontal")
  const root = splitView.tree
  if (root?.kind !== "group") return
  insertAdjacent(root.children[0].id, "top", "top-session")
  const grownRoot = splitView.tree
  if (grownRoot?.kind !== "group") return
  const leftGroup = grownRoot.children[0]
  if (leftGroup.kind !== "group") return
  closePane(leftGroup.children[0].id)
  expect(grownRoot.children.map(child => child.kind)).toEqual(["leaf", "leaf"])
  expect(leafRuntimeIds(grownRoot)).toEqual(["primary", "secondary"])
})

test("suspend preserves membership and restoreIfMember returns the activation action", () => {
  enterSplit("primary", "secondary", "horizontal")
  const root = splitView.tree
  if (root?.kind !== "group") return
  const primaryLeaf = root.children[0]

  suspend()
  expect(splitView.tree).toBeNull()
  expect(splitView.suspendedTree).toBe(root)
  expect(isMember("primary")).toBe(true)
  expect(isMember("outside")).toBe(false)
  expect(runtimeIds()).toEqual(new Set(["primary", "secondary"]))
  expect(restoreIfMember("outside")).toBeNull()

  const restored = restoreIfMember("primary")
  expect(restored).toEqual({ leafId: primaryLeaf.id, runtimeId: "primary" })
  expect(splitView.tree).toBe(root)
  expect(splitView.suspendedTree).toBeNull()
})

test("leafByRuntime and firstLeafRuntime address leaves in the active tree", () => {
  enterSplit("primary", "secondary", "horizontal")
  const primaryLeaf = leafByRuntime("primary")
  expect(primaryLeaf?.runtimeId).toBe("primary")
  expect(leafByRuntime("missing")).toBeNull()
  expect(firstLeafRuntime()).toBe("primary")

  insertAdjacent(primaryLeaf!.id, "bottom", "stacked")
  expect(leafRuntimeIds(splitView.tree!)).toEqual(["primary", "stacked", "secondary"])
  expect(firstLeafRuntime()).toBe("primary")

  closePane(leafByRuntime("stacked")!.id)
  expect(firstLeafRuntime()).toBe("primary")
})
for (const zone of ["left", "right", "top", "bottom"] as const) {
  test(`first ${zone} drop places the new session on the requested side`, () => {
    expect(splitAtEdge("target", zone, "new")).toBe(true)
    const before = zone === "left" || zone === "top"
    expect(leafRuntimeIds(splitView.tree!)).toEqual(before ? ["new", "target"] : ["target", "new"])
    expect(splitView.tree?.kind === "group" && splitView.tree.direction).toBe(
      zone === "left" || zone === "right" ? "horizontal" : "vertical",
    )
  })
}

test("edge drops reject duplicate sessions and missing targets without changing the tree", () => {
  expect(splitAtEdge("primary", "left", "primary")).toBe(false)
  expect(splitView.tree).toBeNull()
  enterSplit("primary", "secondary", "horizontal")
  const before = JSON.stringify(splitView.tree)
  expect(splitAtEdge("primary", "left", "secondary")).toBe(false)
  expect(splitAtEdge("missing", "top", "new")).toBe(false)
  expect(JSON.stringify(splitView.tree)).toBe(before)
  expect(splitAtEdge("secondary", "top", "new")).toBe(true)
  expect(leafRuntimeIds(splitView.tree!)).toEqual(["primary", "new", "secondary"])
})
