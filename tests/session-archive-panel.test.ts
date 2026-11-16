import { afterEach, expect, test, vi } from "vitest"
import { readFileSync } from "node:fs"
import { effectScope, type EffectScope } from "vue"
import { useArchivedSessionPanel, archivedSessionMatches } from "@/composables/useArchivedSessionPanel"
import { announceSessionArchived, onSessionArchived } from "@/lib/sessionArchiveEvents"

const scopes: EffectScope[] = []
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
})

function panel(
  options: { selection?: { file: string; cwd?: string } | null; detailsOpen?: boolean; active?: string } = {},
) {
  const board = {
    selection: options.selection ?? null,
    detailsOpen: options.detailsOpen ?? true,
  }
  const activeFile = { value: options.active ?? (null as string | null) }
  const closeBoardPanel = vi.fn(() => {
    board.selection = null
    board.detailsOpen = false
  })
  const closeRightPanel = vi.fn()
  const scope = effectScope()
  scopes.push(scope)
  scope.run(() =>
    useArchivedSessionPanel({
      board,
      activeSession: () => ({ file: activeFile.value, cwd: "/project" }),
      closeBoardPanel,
      closeRightPanel,
    }),
  )
  return { board, activeFile, closeBoardPanel, closeRightPanel, scope }
}

test("archiving the conversation shown in the board panel clears it and closes the panel", () => {
  const h = panel({ selection: { file: "/sessions/one.jsonl", cwd: "/project" }, detailsOpen: true })
  announceSessionArchived({ file: "/sessions/one.jsonl", project: "/project" })
  expect(h.closeBoardPanel).toHaveBeenCalledOnce()
  expect(h.board).toEqual({ selection: null, detailsOpen: false })
  // 同一条会话的右侧面板也一并收起，不留一个指向已归档会话的面板。
  expect(h.closeRightPanel).toHaveBeenCalledOnce()
})

test("archiving another conversation leaves the open panel and the active conversation alone", () => {
  const h = panel({ selection: { file: "/sessions/one.jsonl", cwd: "/project" }, detailsOpen: true })
  announceSessionArchived({ file: "/sessions/other.jsonl", project: "/project" })
  expect(h.closeBoardPanel).not.toHaveBeenCalled()
  expect(h.closeRightPanel).not.toHaveBeenCalled()
  expect(h.board.selection).toEqual({ file: "/sessions/one.jsonl", cwd: "/project" })
  expect(h.board.detailsOpen).toBe(true)
})

test("a closed board panel does not change the global right-panel switch", () => {
  const h = panel({ selection: { file: "/sessions/one.jsonl", cwd: "/project" }, detailsOpen: false })
  announceSessionArchived({ file: "/sessions/one.jsonl", project: "/project" })
  expect(h.closeBoardPanel).toHaveBeenCalledOnce()
  expect(h.closeRightPanel).not.toHaveBeenCalled()
})

test("chat layout closes the right panel only when the archived conversation is the visible one", () => {
  const h = panel({ selection: null, detailsOpen: false, active: "/sessions/active.jsonl" })
  announceSessionArchived({ file: "/sessions/active.jsonl", project: "/project" })
  expect(h.closeRightPanel).toHaveBeenCalledOnce()
  expect(h.closeBoardPanel).not.toHaveBeenCalled()
  h.closeRightPanel.mockClear()
  announceSessionArchived({ file: "/sessions/elsewhere.jsonl", project: "/project" })
  expect(h.closeRightPanel).not.toHaveBeenCalled()
})

test("draft conversations and remote identities never match by accident", () => {
  expect(archivedSessionMatches({ file: "/sessions/one.jsonl" }, { file: null, cwd: "/project" })).toBe(false)
  expect(archivedSessionMatches({ file: "/sessions/one.jsonl" }, null)).toBe(false)
  // 远程会话按「项目 + 文件」比较，同名文件在不同端点上不是同一条会话。
  expect(
    archivedSessionMatches(
      { file: "/remote/one.jsonl", project: "ssh://host/project" },
      { file: "/remote/one.jsonl", cwd: "ssh://host/project" },
    ),
  ).toBe(true)
  expect(
    archivedSessionMatches({ file: "/remote/one.jsonl", project: "ssh://host/project" }, { file: "/remote/one.jsonl" }),
  ).toBe(false)
})

test("the panel stops reacting once its scope is disposed", () => {
  const h = panel({ selection: { file: "/sessions/one.jsonl", cwd: "/project" } })
  h.scope.stop()
  announceSessionArchived({ file: "/sessions/one.jsonl", project: "/project" })
  expect(h.closeBoardPanel).not.toHaveBeenCalled()
})

test("archiving does not switch the conversation under the panel", () => {
  const h = panel({ selection: { file: "/sessions/one.jsonl", cwd: "/project" }, active: "/sessions/active.jsonl" })
  announceSessionArchived({ file: "/sessions/one.jsonl", project: "/project" })
  // 面板收敛只动面板本身：未归档会话的切换（active runtime）不受影响。
  expect(h.activeFile.value).toBe("/sessions/active.jsonl")
})

test("subscribers can unsubscribe and additional listeners all receive the event", () => {
  const first = vi.fn()
  const second = vi.fn()
  const off = onSessionArchived(first)
  const offSecond = onSessionArchived(second)
  announceSessionArchived({ file: "/sessions/one.jsonl" })
  expect(first).toHaveBeenCalledExactlyOnceWith({ file: "/sessions/one.jsonl" })
  expect(second).toHaveBeenCalledExactlyOnceWith({ file: "/sessions/one.jsonl" })
  off()
  offSecond()
  announceSessionArchived({ file: "/sessions/two.jsonl" })
  expect(first).not.toHaveBeenCalledTimes(2)
  expect(second).not.toHaveBeenCalledTimes(2)
})

test("the app shell wires board panel and right sidebar closure to the archive event", () => {
  const app = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8")
  // 看板选中卡片 / 详情面板与右侧面板开关都在 App 层，接线必须在这里落点。
  expect(app).toMatch(/useArchivedSessionPanel\(\{/)
  expect(app).toMatch(/closeBoardPanel: \(\) => \{\s*board\.selection = null\s*board\.detailsOpen = false\s*\}/)
  expect(app).toMatch(/closeRightPanel: \(\) => \(rightSidebarOpen\.value = false\)/)
  const store = readFileSync(new URL("../src/stores/workspace.ts", import.meta.url), "utf8")
  // 派发点放在元数据写入成功之后：所有归档入口都经过 workspace.update。
  expect(store).toMatch(/if \(archived && !wasArchived\) announceSessionArchived\(/)
})
