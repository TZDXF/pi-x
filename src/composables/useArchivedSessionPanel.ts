import { onScopeDispose } from "vue"
import { sameSessionIdentity } from "@/lib/sessionIdentity"
import { onSessionArchived, type ArchivedSession } from "@/lib/sessionArchiveEvents"

/** 面板里正在显示的会话；`file` 为空表示草稿态（尚未落盘，不可能被归档）。 */
export interface PanelSession {
  file?: string | null
  cwd?: string
}

/** 归档成功后需要收敛的面板状态；由 `App.vue` 提供实际引用。 */
export interface ArchivedSessionPanelContext {
  /** 看板右侧会话面板：`selection` 是面板里正在显示的那张卡片。 */
  board: {
    selection: PanelSession | null
    detailsOpen: boolean
  }
  /** 聊天布局里主区正在显示的会话（`session.sessionFile` / `session.cwd`）。 */
  activeSession: () => PanelSession | null | undefined
  /** 关闭看板右侧会话面板（清掉选中卡片并收起面板）。 */
  closeBoardPanel: () => void
  /** 收起右侧面板（`rightSidebarOpen`）；会话 Tab 保留，撤销归档后原样恢复。 */
  closeRightPanel: () => void
}

/** 归档事件是否正好命中该面板正在显示的会话（远程会话按项目 + 文件身份比较）。 */
export function archivedSessionMatches(archived: ArchivedSession, target: PanelSession | null | undefined) {
  return !!target?.file && sameSessionIdentity(target.file, target.cwd, archived.file, archived.project)
}

/**
 * 归档成功即收敛"正在显示这条会话"的面板（TZD-121）。
 *
 * 归档只把会话从侧栏/看板列表里移除，正在显示它的面板（看板右侧会话面板、按会话
 * 分组的右侧侧栏）是另一份状态，不会自己收起来。这里只处理**匹配到的那一条**：
 * 归档别的会话时既不收面板也不切会话，未归档会话的切换因此完全不受影响。
 *
 * 看板布局下右侧面板（`ChatView` 的侧栏）与详情面板显示的是同一条会话，所以命中
 * 就一起收敛；聊天布局下只对应"主区会话 = 被归档会话"的侧栏。
 */
export function useArchivedSessionPanel(context: ArchivedSessionPanelContext): void {
  onScopeDispose(
    onSessionArchived(archived => {
      if (archivedSessionMatches(archived, context.board.selection)) {
        const panelOpen = context.board.detailsOpen
        context.closeBoardPanel()
        // 没有面板在显示这条会话时，别动全局的右侧面板开关。
        if (panelOpen) context.closeRightPanel()
        return
      }
      if (archivedSessionMatches(archived, context.activeSession())) context.closeRightPanel()
    }),
  )
}
