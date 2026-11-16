import { readFileSync } from "node:fs"
import { afterEach, expect, test, vi } from "vitest"
import { effectScope, nextTick, reactive, ref, type EffectScope } from "vue"
import * as vue from "vue"
import { ModuleKind, ScriptTarget, transpileModule } from "typescript"
import * as paths from "@/lib/paths"
import * as identities from "@/lib/sessionIdentity"
import { isRemoteProject } from "@/lib/ssh"
import { kanbanLivePreview } from "@/lib/kanbanLivePreview"
import { useArchivedSessionPanel } from "@/composables/useArchivedSessionPanel"
import { announceSessionArchived } from "@/lib/sessionArchiveEvents"
import { boardPanelSessions } from "@/lib/boardPanelSessions"

// 看板侧的真实模型回归（TZD-121）：`useKanbanWorkspace` 的草稿演进 watcher、
// `selectedCard` 的 `draftId` 回退语义以及归档收敛判断全部走真实实现，
// 只把 Vue 之外的 store/RPC 依赖替换成桩。
const source = readFileSync(new URL("../src/composables/useKanbanWorkspace.ts", import.meta.url), "utf8")
const scopes: EffectScope[] = []
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
})

function harness(historyLoaded = true) {
  const owners = reactive(new Map<string, Record<string, unknown>>())
  const interfaces = reactive(new Map<string, Record<string, unknown>>())
  const activities = reactive(new Map<string, unknown>())
  const statuses = reactive(new Map<string, string>())
  const composerDrafts = reactive(new Map<string, { text: string; files: unknown[] }>())
  let sequence = 0
  const sessionFor = vi.fn((id: string) => {
    if (!owners.has(id))
      owners.set(
        id,
        reactive({
          runtimeId: id,
          cwd: "",
          sessionFile: null,
          entries: [] as unknown[],
          partialBlocks: null,
          runs: {},
          promptQueue: [] as unknown[],
          isStreaming: false,
          isCompacting: false,
          retryInfo: null,
          loadOfflineModels: vi.fn(async () => {}),
          setDesiredModel: vi.fn(),
          setDesiredThinkingLevel: vi.fn(),
        }),
      )
    return owners.get(id)!
  })
  const uiFor = vi.fn((id: string) => {
    if (!interfaces.has(id)) interfaces.set(id, reactive({ activeDialog: null }))
    return interfaces.get(id)!
  })
  const workspace = reactive({
    boardDrafts: {} as Record<string, Record<string, unknown>>,
    sessionActivities: {},
    sessionAcknowledgements: {},
    histories: (historyLoaded ? { "/root": [], "/root/linked": [], "/loose": [] } : {}) as Record<string, unknown[]>,
    projectless: "/loose",
    ensureProjectless: vi.fn(async () => "/loose"),
    orderedProjects: () => ["/root"],
    projectFolders: (path: string) => (path === "/root" ? ["/root", "/root/linked"] : []),
    projectRoot: (path: string) => (path === "/root/linked" ? "/root" : path),
    projectName: () => "Project",
    isProjectless: (path: string) => path === "/loose",
    refresh: vi.fn(async () => {}),
    flushPersistence: vi.fn(async () => {}),
    upsertBoardDraft: vi.fn((draft: Record<string, unknown>) => {
      workspace.boardDrafts[draft.id as string] = { ...draft }
    }),
  })
  const dependencies = {
    vue,
    "@/stores/conversations": {
      allConversations: () => [...owners.values()],
      sessionFor,
      uiFor,
      findConversation: (file: string, project: string) =>
        [...owners.values()].find(owner =>
          identities.sameSessionIdentity(owner.sessionFile as string, owner.cwd as string, file, project),
        ),
    },
    "@/stores/sessionRunStatus": {
      sessionRunStatus: (file: string, project: string) => statuses.get(identities.sessionIdentityKey(file, project)),
      sessionActivitySnapshot: (file: string, project: string) =>
        activities.get(identities.sessionIdentityKey(file, project)),
    },
    "@/stores/composerDrafts": {
      composerDraftText: (_project: string, file: string) => composerDrafts.get(file)?.text ?? "",
      composerDraftFiles: (_project: string, file: string) => composerDrafts.get(file)?.files ?? [],
    },
    "@/lib/sessionIdentity": identities,
    "@/lib/paths": paths,
    "@/lib/ssh": { isRemoteProject },
    "@/lib/uuid": { createUuid: () => `draft-${++sequence}` },
    "@/lib/kanbanLivePreview": { kanbanLivePreview },
  }
  const code = transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} as Record<string, unknown> }
  new Function("exports", "require", "module", code)(
    module.exports,
    (id: string) => dependencies[id as keyof typeof dependencies],
    module,
  )
  const scope = effectScope()
  scopes.push(scope)
  const enabled = ref(false)
  const model = scope.run(() =>
    (module.exports.useKanbanWorkspace as (workspace: unknown, enabled: () => boolean) => Record<string, unknown>)(
      workspace,
      () => enabled.value,
    ),
  )!
  const board = reactive(model) as unknown as {
    selection: { file?: string; cwd?: string; draftId?: string; id?: string } | null
    detailsOpen: boolean
    cards: { file?: string; draftId?: string }[]
    selectedCard: { file?: string; draftId?: string; cwd?: string } | null
    createDraft: (input: { project: string; message: string }) => Promise<{ id: string }>
  }
  return { board, workspace, sessionFor, scope }
}

/** 与 `App.vue` 的接线一致：身份候选来自看板模型、草稿索引与活运行时。 */
function wireArchivePanel(
  board: { selection: unknown; detailsOpen: boolean },
  workspace: { boardDrafts: Record<string, Record<string, unknown>> },
  sessionFor: (id: string) => Record<string, unknown>,
  options: { selectedCard: () => unknown; visible?: () => boolean; right: { value: boolean } },
) {
  const scope = effectScope()
  scopes.push(scope)
  scope.run(() =>
    useArchivedSessionPanel({
      boardVisible: () => (options.visible?.() ?? true) && board.detailsOpen,
      boardSessions: () =>
        boardPanelSessions({
          selectedCard: options.selectedCard() as never,
          selection: board.selection as never,
          draft: id => {
            const draft = workspace.boardDrafts[id]
            return { file: draft?.sessionFile as string | undefined, cwd: draft?.project as string | undefined }
          },
          runtime: id => {
            const owner = sessionFor(id)
            return { file: owner?.sessionFile as string | undefined, cwd: owner?.cwd as string | undefined }
          },
        }),
      activeSession: () => ({ file: sessionFor("default").sessionFile as string, cwd: "/root" }),
      closeBoardPanel: () => {
        board.selection = null
        board.detailsOpen = false
      },
      closeRightPanel: () => {
        options.right.value = false
      },
    }),
  )
  return scope
}

test("a draft that gains a file after its first send still closes the board panel when archived", async () => {
  const { board, workspace, sessionFor } = harness()
  const draft = await board.createDraft({ project: "/root", message: "First prompt" })
  board.selection = board.cards.find(card => card.draftId === draft.id) ?? null
  board.detailsOpen = true
  // 打开面板时的快照是草稿卡：没有 file，只有 draftId。
  expect(board.selection?.file).toBeUndefined()
  const owner = sessionFor(draft.id)
  Object.assign(owner, {
    cwd: "/root",
    sessionFile: "/sessions/new.jsonl",
    started: true,
    entries: [{ kind: "user", text: "First prompt" }],
  })
  await nextTick()
  workspace.histories["/root"] = [{ file: "/sessions/new.jsonl", cwd: "/root", archived: false }]
  await nextTick()
  // 真实 `selectedCard` 已由 draftId 演进到带文件的新快照，而 selection 仍是旧快照。
  expect(board.selectedCard?.file).toBe("/sessions/new.jsonl")
  expect(board.selection?.file).toBeUndefined()
  const right = ref(true)
  wireArchivePanel(board, workspace, sessionFor as never, { selectedCard: () => board.selectedCard, right })
  workspace.histories["/root"]![0] = { file: "/sessions/new.jsonl", cwd: "/root", archived: true } as never
  announceSessionArchived({ file: "/sessions/new.jsonl", project: "/root" })
  expect(board.cards).toHaveLength(0)
  expect(right.value).toBe(false)
  expect(board.detailsOpen).toBe(false)
  expect(board.selection).toBe(null)
})

test("a saved card closes its own board panel, and an unrelated archive leaves it open", async () => {
  const { board, workspace, sessionFor } = harness()
  workspace.histories["/root"] = [
    { file: "/sessions/A.jsonl", cwd: "/root", title: "A" },
    { file: "/sessions/B.jsonl", cwd: "/root", title: "B" },
  ]
  const card = board.cards.find(item => item.file === "/sessions/A.jsonl")!
  board.selection = card as never
  board.detailsOpen = true
  const right = ref(true)
  wireArchivePanel(board, workspace, sessionFor as never, { selectedCard: () => board.selectedCard, right })
  announceSessionArchived({ file: "/sessions/B.jsonl", project: "/root" })
  // reactive 包装后引用不同，按身份比较即可。
  expect(board.selection?.file).toBe("/sessions/A.jsonl")
  expect(board.detailsOpen).toBe(true)
  expect(right.value).toBe(true)
  announceSessionArchived({ file: "/sessions/A.jsonl", project: "/root" })
  expect(board.selection).toBe(null)
  expect(board.detailsOpen).toBe(false)
  expect(right.value).toBe(false)
})

test("an unchanged board model keeps the stale detail snapshot when archive handling is absent", () => {
  const { board, workspace } = harness()
  workspace.histories["/root"] = [{ file: "/sessions/A.jsonl", cwd: "/root", title: "A" }]
  board.selection = board.cards[0] as never
  board.detailsOpen = true
  workspace.histories["/root"]![0] = { file: "/sessions/A.jsonl", cwd: "/root", archived: true } as never
  // 这就是缺陷的根因形态：卡片被过滤掉后 selectedCard 回退到旧快照、详情仍是打开的。
  expect(board.cards).toHaveLength(0)
  expect(board.selectedCard?.file).toBe("/sessions/A.jsonl")
  expect(board.detailsOpen).toBe(true)
})

test("an invisible board panel (chat layout) does not consume the archive event", async () => {
  const { board, workspace, sessionFor } = harness()
  workspace.histories["/root"] = [{ file: "/sessions/A.jsonl", cwd: "/root", title: "A" }]
  board.selection = board.cards[0] as never
  board.detailsOpen = true
  const right = ref(true)
  wireArchivePanel(board, workspace, sessionFor as never, {
    selectedCard: () => board.selectedCard,
    visible: () => false,
    right,
  })
  Object.assign(sessionFor("default"), { sessionFile: "/sessions/B.jsonl", cwd: "/root" })
  announceSessionArchived({ file: "/sessions/A.jsonl", project: "/root" })
  expect(board.selection).not.toBe(null)
  expect(board.detailsOpen).toBe(true)
  expect(right.value).toBe(true)
})
