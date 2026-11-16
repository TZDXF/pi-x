import { peekConversation } from "@/stores/conversations"
import { rpcRequest } from "@/api/client/rpc"
import { sessionHistory } from "@/api/client/sessions"
import { collectAuxParentContext } from "@/lib/auxContextCollect"
import { claimAuxParentContext } from "@/stores/auxContext"
import type { SessionStore } from "@/stores/session"

/**
 * aux 面板的**父上下文**接线：首轮发送前取一次父会话已提交分支，之后永不再取
 * （`docs/aux-chat-spec.md` §3/§4）。
 *
 * 三条边界：
 * - 取材只打**父 runtime**（Main 策略）的 `rpc_request`；绝不新增 aux 侧的父会话查询。
 * - `streaming` 读父会话 store 的实时值（不是打开面板时的快照）：父会话此刻在流式，
 *   最后一条已提交 user 之后的半轮就必须排除。
 * - 失败只降级成"块里是顶部提示"，**不阻断发送**（父上下文是附带内容）。
 */
export function useAuxParentContext(deps: {
  /** aux 实例 id（`contextInjected` 的记账键）。 */
  auxRuntimeId: string
  /** 父（主）会话 runtimeId。 */
  parentRuntimeId: string
  /** aux 自己的 session store（判断"是否已有 user 条目"）。 */
  session: SessionStore
}) {
  async function parentContext(): Promise<string | null> {
    return claimAuxParentContext(deps.auxRuntimeId, {
      // 已经有 user 条目就不是首轮：即便记账丢了（重载/并发提交），也不能再拼块。
      hasUserEntry: () => deps.session.entries.some(entry => entry.kind === "user"),
      collect: () => {
        const parent = peekConversation(deps.parentRuntimeId)
        return collectAuxParentContext(
          {
            request: (command, runtimeId) => rpcRequest(command, runtimeId),
            readHistory: file => sessionHistory(file) as Promise<unknown[]>,
          },
          {
            parentRuntimeId: deps.parentRuntimeId,
            streaming: !!parent?.isStreaming,
            sessionFile: parent?.sessionFile ?? null,
          },
        )
      },
    })
  }

  return { parentContext }
}
