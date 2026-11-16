/**
 * 归档成功后的进程内通知（TZD-121）。
 *
 * 归档会把会话从侧栏/看板列表里移除，但"正好显示这条会话"的面板（看板的右侧
 * 会话面板、按会话分组的右侧侧栏）是独立状态：它们不会因为列表少了一行自己
 * 收起来，于是界面上继续摆着一条已经归档的会话。
 *
 * 这里只做"归档成功了"这一个事实的广播；要不要收敛面板、收敛哪一个，由订阅方
 * （`composables/useArchivedSessionPanel.ts`）按会话身份判断 —— 不同会话的切换与
 * 面板状态一概不受影响。派发点在 `stores/workspace.ts#update`：所有归档入口
 * （侧栏行、右键菜单、看板卡片、全部归档）都经过同一次元数据写入，只有一个漏斗。
 */

export interface ArchivedSession {
  file: string
  /** 会话所属项目；写入时历史里没匹配到（例如尚未加载）时省略。 */
  project?: string
}

type ArchivedSessionListener = (session: ArchivedSession) => void

const listeners = new Set<ArchivedSessionListener>()

/** 订阅归档成功事件；返回退订函数。 */
export function onSessionArchived(listener: ArchivedSessionListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 元数据写入成功且会话**变为已归档**后调用；恢复（取消归档）与写入失败都不派发。 */
export function announceSessionArchived(session: ArchivedSession): void {
  // 先复制再派发：监听者可能在收敛面板的过程中退订（组件随面板卸载）。
  for (const listener of [...listeners]) listener(session)
}
