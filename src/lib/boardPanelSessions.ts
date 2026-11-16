import type { PanelSession } from "@/composables/useArchivedSessionPanel"

/** 看板卡片里与本判断相关的最小字段（`KanbanCard` 结构兼容）。 */
export interface BoardPanelCard {
  file?: string | null
  cwd?: string
  /** 分组根目录；卡片没有真实 cwd 时退回它。 */
  project?: string
  draftId?: string
  runtimeId?: string
}

export interface BoardPanelSources {
  /** 看板模型按 `draftId` 跟随演进后的当前卡片（`board.selectedCard`）。 */
  selectedCard?: BoardPanelCard | null
  /** 用户当初点开面板时的卡片快照（`board.selection`），可能已过期。 */
  selection?: BoardPanelCard | null
  /** 草稿索引：`draftId` → 已落盘的会话身份。 */
  draft?: (draftId: string) => PanelSession | null | undefined
  /** 仍在内存里的运行时：`runtimeId`/`draftId` → 会话身份。 */
  runtime?: (runtimeId: string) => PanelSession | null | undefined
}

/**
 * 看板详情面板**当前可能正在显示**的会话身份集合（TZD-121）。
 *
 * 为什么不是单一身份：卡片是"列表投影"，选中之后它还会演进 ——
 *
 * - 草稿首次落盘后，真实身份由 `draftId` 演进到带 `file` 的新卡片（`selectedCard`），
 *   而当初点开面板时存下的 `selection` 仍是无 `file` 的旧快照；
 * - 卡片被列表过滤掉（归档、状态变化）之后，`selectedCard` 又会回退到那份旧快照。
 *
 * 所以这里同时收集几条来源（当前卡片、旧快照、草稿索引、活着的运行时），任意一条命中
 * 被归档的会话就说明面板里摆的正是它。去重后顺序稳定，便于调用方与测试核对。
 */
export function boardPanelSessions(sources: BoardPanelSources): PanelSession[] {
  const identity = (target: PanelSession | null | undefined): PanelSession | null =>
    target?.file ? { file: target.file, cwd: target.cwd } : null
  const cardSession = (card: BoardPanelCard | null | undefined) =>
    identity(card ? { file: card.file, cwd: card.cwd || card.project } : null)
  const keyedSession = (id: string | undefined, resolve: (id: string) => PanelSession | null | undefined) =>
    id ? identity(resolve(id)) : null
  const draftId = sources.selectedCard?.draftId ?? sources.selection?.draftId
  const runtimeId = sources.selectedCard?.runtimeId ?? sources.selection?.runtimeId ?? draftId
  const candidates = [
    cardSession(sources.selectedCard),
    cardSession(sources.selection),
    keyedSession(draftId, id => sources.draft?.(id)),
    keyedSession(runtimeId, id => sources.runtime?.(id)),
  ]
  const unique = new Map<string, PanelSession>()
  for (const candidate of candidates) {
    if (!candidate) continue
    // 远程会话的同名文件在不同端点上是两条会话，键里保留项目。
    unique.set(`${candidate.cwd ?? ""}\u0000${candidate.file}`, candidate)
  }
  return [...unique.values()]
}
