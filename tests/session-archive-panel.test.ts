import { readFileSync } from "node:fs"
import { afterEach, expect, test, vi } from "vitest"
import { effectScope, type EffectScope } from "vue"
import {
  anyArchivedMatch,
  archivedSessionMatches,
  useArchivedSessionPanel,
} from "@/composables/useArchivedSessionPanel"
import { boardPanelSessions } from "@/lib/boardPanelSessions"
import { announceSessionArchived, onSessionArchived } from "@/lib/sessionArchiveEvents"

const scopes: EffectScope[] = []
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
})

interface PanelOptions {
  visible?: boolean
  detailsOpen?: boolean
  selectedCard?: { file?: string | null; cwd?: string } | null
  selection?: { file?: string | null; cwd?: string; draftId?: string } | null
  drafts?: Record<string, { sessionFile?: string; project?: string }>
  runtimes?: Record<string, { sessionFile?: string; cwd?: string }>
  active?: { file: string; cwd: string } | null
}

function panel(options: PanelOptions = {}) {
  const state = {
    selection: options.selection ?? null,
    detailsOpen: options.detailsOpen ?? true,
  }
  const closeBoardPanel = vi.fn(() => {
    state.selection = null
    state.detailsOpen = false
  })
  const closeRightPanel = vi.fn()
  const selectedCard = () => options.selectedCard ?? null
  const scope = effectScope()
  scopes.push(scope)
  scope.run(() =>
    useArchivedSessionPanel({
      boardVisible: () => (options.visible ?? true) && state.detailsOpen,
      boardSessions: () =>
        boardPanelSessions({
          selectedCard: selectedCard(),
          selection: state.selection,
          draft: id => {
            const draft = options.drafts?.[id]
            return { file: draft?.sessionFile, cwd: draft?.project }
          },
          runtime: id => {
            const owner = options.runtimes?.[id]
            return { file: owner?.sessionFile, cwd: owner?.cwd }
          },
        }),
      activeSession: () => options.active ?? null,
      closeBoardPanel,
      closeRightPanel,
    }),
  )
  return { state, closeBoardPanel, closeRightPanel, scope }
}

test("the visible board panel of the archived session clears its selection and closes", () => {
  const h = panel({ selectedCard: { file: "/sessions/one.jsonl", cwd: "/project" } })
  announceSessionArchived({ file: "/sessions/one.jsonl", project: "/project" })
  expect(h.closeBoardPanel).toHaveBeenCalledOnce()
  expect(h.state).toEqual({ selection: null, detailsOpen: false })
  expect(h.closeRightPanel).toHaveBeenCalledOnce()
})

test("a hidden board selection never closes the sidebar of another visible chat session", () => {
  // 聊天布局：看板选择仍在内存里，但它不是用户看到的区域。
  const h = panel({
    visible: false,
    selectedCard: { file: "/sessions/one.jsonl", cwd: "/project" },
    active: { file: "/sessions/two.jsonl", cwd: "/project" },
  })
  announceSessionArchived({ file: "/sessions/one.jsonl", project: "/project" })
  expect(h.closeBoardPanel).not.toHaveBeenCalled()
  expect(h.closeRightPanel).not.toHaveBeenCalled()
})

test("a closed board panel does not short-circuit closure of the visible chat session", () => {
  const h = panel({
    detailsOpen: false,
    selectedCard: { file: "/sessions/one.jsonl", cwd: "/project" },
    active: { file: "/sessions/one.jsonl", cwd: "/project" },
  })
  announceSessionArchived({ file: "/sessions/one.jsonl", project: "/project" })
  expect(h.closeBoardPanel).not.toHaveBeenCalled()
  expect(h.closeRightPanel).toHaveBeenCalledOnce()
})

test("a draft that gained a file closes its panel through the draft index", () => {
  // 打开面板时的 selection 是草稿卡（无 file），真实身份在草稿索引里。
  const h = panel({
    selection: { file: null, cwd: "/project", draftId: "draft-1" },
    drafts: { "draft-1": { sessionFile: "/sessions/new.jsonl", project: "/project" } },
  })
  expect(boardPanelSessions({ selection: h.state.selection })).toEqual([])
  announceSessionArchived({ file: "/sessions/new.jsonl", project: "/project" })
  expect(h.closeBoardPanel).toHaveBeenCalledOnce()
  expect(h.closeRightPanel).toHaveBeenCalledOnce()
})

test("archiving an unrelated session keeps the visible board panel and conversation", () => {
  const h = panel({
    selectedCard: { file: "/sessions/one.jsonl", cwd: "/project" },
    active: { file: "/sessions/one.jsonl", cwd: "/project" },
  })
  announceSessionArchived({ file: "/sessions/other.jsonl", project: "/project" })
  expect(h.closeBoardPanel).not.toHaveBeenCalled()
  expect(h.closeRightPanel).not.toHaveBeenCalled()
  expect(h.state.detailsOpen).toBe(true)
})

test("chat layout closes the right panel only when the archived conversation is the visible one", () => {
  const h = panel({
    selectedCard: null,
    detailsOpen: false,
    active: { file: "/sessions/active.jsonl", cwd: "/project" },
  })
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
  expect(
    anyArchivedMatch({ file: "/sessions/one.jsonl" }, [null, { file: null }, { file: "/sessions/one.jsonl" }]),
  ).toBe(true)
  expect(anyArchivedMatch({ file: "/sessions/one.jsonl" }, [null, { file: null }])).toBe(false)
})

test("boardPanelSessions collects every identity the selected card may have evolved into", () => {
  const sessions = boardPanelSessions({
    selectedCard: { file: "/sessions/new.jsonl", cwd: "/project", draftId: "draft-1", runtimeId: "rt-1" },
    selection: { file: null, cwd: "/project", draftId: "draft-1" },
    draft: id => (id === "draft-1" ? { file: "/sessions/new.jsonl", cwd: "/project" } : null),
    runtime: id => (id === "rt-1" ? { file: "/sessions/new.jsonl", cwd: "/project" } : null),
  })
  // 同一条会话被多条来源重复给出时只保留一份。
  expect(sessions).toEqual([{ file: "/sessions/new.jsonl", cwd: "/project" }])
  // 卡片没有真实 cwd 时退回分组根目录（与看板卡片 `cwd || project` 的取法一致）。
  expect(boardPanelSessions({ selectedCard: { file: "/sessions/a.jsonl", project: "/root" } })).toEqual([
    { file: "/sessions/a.jsonl", cwd: "/root" },
  ])
  // 卡片被列表过滤掉后 selectedCard 回退到旧快照：旧身份仍会被收进来。
  expect(
    boardPanelSessions({ selectedCard: { file: "/sessions/old.jsonl", cwd: "/project" }, selection: null }),
  ).toEqual([{ file: "/sessions/old.jsonl", cwd: "/project" }])
})

test("the panel stops reacting once its scope is disposed", () => {
  const h = panel({ selectedCard: { file: "/sessions/one.jsonl", cwd: "/project" } })
  h.scope.stop()
  announceSessionArchived({ file: "/sessions/one.jsonl", project: "/project" })
  expect(h.closeBoardPanel).not.toHaveBeenCalled()
})

test("archiving does not switch the conversation under the panel", () => {
  const active = { file: "/sessions/active.jsonl", cwd: "/project" }
  const panelState = panel({ selectedCard: { file: "/sessions/one.jsonl", cwd: "/project" }, active })
  announceSessionArchived({ file: "/sessions/one.jsonl", project: "/project" })
  // 面板收敛只动面板本身：未归档会话的切换（active runtime）不受影响。
  expect(panelState.state.detailsOpen).toBe(false)
  expect(active.file).toBe("/sessions/active.jsonl")
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
  expect(first).toHaveBeenCalledOnce()
  expect(second).toHaveBeenCalledOnce()
})

test("the app shell wires the real board identity sources into the archive listener", () => {
  const app = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8")
  // 可见性来自真实布局（`showKanban`）与详情面板展开状态，不是原始 selection：
  // 旧实现只看 `board.selection`，隐藏/已关闭的看板面板会误关聊天布局的侧栏。
  expect(app).toMatch(/boardVisible: \(\) => showKanban\.value && board\.detailsOpen/)
  // 身份候选汇总 selectedCard + selection + 草稿索引 + 活运行时。
  expect(app).toMatch(/boardSessions: \(\) =>\s*boardPanelSessions\(\{/)
  expect(app).toMatch(/selectedCard: board\.selectedCard,\s*selection: board\.selection,/s)
  expect(app).toMatch(/closeBoardPanel: \(\) => \{\s*board\.selection = null\s*board\.detailsOpen = false\s*\}/)
  expect(app).toMatch(/closeRightPanel: \(\) => \(rightSidebarOpen\.value = false\)/)
  const store = readFileSync(new URL("../src/stores/workspace.ts", import.meta.url), "utf8")
  // 派发点放在元数据写入成功之后：所有归档入口都经过 workspace.update。
  expect(store).toMatch(/if \(archived && !wasArchived\) announceSessionArchived\(/)
})
