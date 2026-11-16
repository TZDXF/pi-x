import { onScopeDispose } from "vue"
import { sameSessionIdentity } from "@/lib/sessionIdentity"
import { onSessionArchived, type ArchivedSession } from "@/lib/sessionArchiveEvents"

/** 一条会话的身份；`file` 为空表示尚未落盘（草稿态，不可能被归档）。 */
export interface PanelSession {
  file?: string | null
  /** 会话所属项目/真实 cwd；远程会话的身份由"项目 + 文件"共同决定。 */
  cwd?: string
}

/** 归档成功后需要收敛的面板状态；由 `App.vue` 提供实际引用。 */
export interface ArchivedSessionPanelContext {
  /**
   * 看板详情面板此刻是否是用户真正看到的那块区域：布局为看板、详情展开、phase/route 允许。
   *
   * 切到聊天布局后看板状态仍留在内存里（`App.vue` 切布局只清 `detailsOpen`），不做这层
   * 可见性判断，隐藏的看板选择就会被当成"正在显示"，误关聊天布局里另一条会话的侧栏
   * （TZD-121 复现之一）。详情已关时同理：面板没在显示，不能吃掉归档事件、也不能把
   * 判断短路掉（TZD-121 复现之二）。
   */
  boardVisible: () => boolean
  /**
   * 看板详情面板**当前**可能正在显示的会话身份，可能多于一条。
   *
   * 必须由调用方从"真实选中的卡片/会话"推导，而不是只看原始 `selection`：草稿首次
   * 落盘后 `selection` 仍是无 `file` 的旧快照，真实身份已经由 `draftId` 演进到带文件的
   * 新快照（TZD-121 复现之二）。看板卡片被列表过滤掉之后 `selectedCard` 也会回退到
   * 旧快照，所以调用方要连同草稿索引/活运行时一起给出候选身份。
   */
  boardSessions: () => (PanelSession | null | undefined)[]
  /** 聊天布局里主区正在显示的会话（`session.sessionFile` / `session.cwd`）。 */
  activeSession: () => PanelSession | null | undefined
  /** 关闭看板详情面板（清掉选中卡片并收起面板）。 */
  closeBoardPanel: () => void
  /** 收起右侧面板（`rightSidebarOpen`）；会话 Tab 保留，撤销归档后原样恢复。 */
  closeRightPanel: () => void
}

/** 该身份是否就是被归档的那条会话（远程会话按项目 + 文件身份比较）。 */
export function archivedSessionMatches(archived: ArchivedSession, target: PanelSession | null | undefined) {
  return !!target?.file && sameSessionIdentity(target.file, target.cwd, archived.file, archived.project)
}

/** 候选身份里是否有一条命中被归档的会话。 */
export function anyArchivedMatch(
  archived: ArchivedSession,
  targets: readonly (PanelSession | null | undefined)[],
): boolean {
  return targets.some(target => archivedSessionMatches(archived, target))
}

/**
 * 归档成功即收敛"正在显示这条会话"的面板（TZD-121）。
 *
 * 归档只把会话从侧栏/看板列表里移除，正在显示它的面板（看板详情面板、按会话分组
 * 的右侧侧栏）是另一份状态，不会自己收起来。这里只处理**命中当前显示**的那一条：
 * 归档别的会话时既不收面板也不切会话，未归档会话的切换因此完全不受影响。
 *
 * 判断顺序即"哪个面板真的在显示"：
 *
 * 1. 看板详情面板**可见且展开**、且当前选中卡片命中 → 清选中、收起详情，并收起共享的
 *    右侧面板（该布局下它就是这条会话的侧栏）；
 * 2. 否则退回聊天布局的"主区会话 = 被归档会话"→ 只收起右侧面板。
 *
 * 隐藏/已关闭的看板选择不参与判断，因此不会误伤聊天布局里另一条会话的侧栏。
 */
export function useArchivedSessionPanel(context: ArchivedSessionPanelContext): void {
  onScopeDispose(
    onSessionArchived(archived => {
      if (context.boardVisible() && anyArchivedMatch(archived, context.boardSessions())) {
        context.closeBoardPanel()
        context.closeRightPanel()
        return
      }
      if (archivedSessionMatches(archived, context.activeSession())) context.closeRightPanel()
    }),
  )
}
