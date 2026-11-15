/**
 * aux（辅助对话）父上下文的**取材**：从**父 runtime**（Main 策略）取已提交分支。
 *
 * 规格来源 `docs/aux-chat-spec.md` §3。三条来源按同一份归一化与截断规则收敛：
 * 1. 主路径 `get_entries`（父进程内存里**已追加**的条目，按 `leafId→parentId` 回溯活动分支）；
 * 2. 备选 `get_messages`（压缩投影语义）；
 * 3. 兜底 `session_history`（文件投影，Rust 侧已按 parentId 回溯活动分支）。
 *
 * 三条铁律：
 - 查询**只打父 runtime**：`rpcRequest(command, parentRuntimeId)`。绝不通过 aux 网关
   去查父会话（aux 策略是 Aux、argv 带 `--no-session`，那里根本没有父会话）。
 - 取材失败**不得**降级成"未取到父上下文"：只有"确实还没有已提交输入"才是空提示；
   某一路失败就换下一路，最后才承认拿不到（并保留空提示而不是报错）。
 - 成本如实：父上下文前缀在后续**每一轮**作为历史全价重发（`cacheWrite` 实测为 0），
   本模块不主张任何前缀缓存收益；32k 护栏正是为这个全价成本设的硬上限。

 * `streaming` 由调用方给出（父会话是否在流式）。它决定截断锚点：流式中最后一条
 * 已提交 user 之后的 assistant/toolResult 属于**正在敲的半轮**，必须排除。
 */
import {
  activeBranchEntries,
  auxMessagesFromEntries,
  auxMessagesFromMessages,
  buildAuxParentContext,
  type AuxParentContextResult,
} from "@/lib/auxParentContext"

/** 取材来源（诊断与测试断言用）。 */
export type AuxContextSource = "entries" | "messages" | "history" | "none"

export interface AuxContextCollectDeps {
  /** 对**指定 runtime** 发 RPC（父会话 runtimeId）。 */
  request: (
    command: Record<string, unknown>,
    runtimeId: string,
  ) => Promise<{ success: boolean; data?: unknown; error?: string }>
  /** 读会话文件（`session_history`）；父会话没有 sessionFile 时不会被调用。 */
  readHistory?: (file: string) => Promise<unknown[] | null>
  /** 32k 护栏（测试可调小）。 */
  maxChars?: number
}

export interface AuxContextCollectInput {
  /** 父（主）会话 runtimeId。 */
  parentRuntimeId: string
  /** 父会话是否正在流式（流式中排除半轮）。 */
  streaming: boolean
  /** 父会话的 sessionFile（兜底路径用；`null` 表示还没有落盘）。 */
  sessionFile?: string | null
}

export interface AuxContextCollectResult extends AuxParentContextResult {
  source: AuxContextSource
  /** 三路都失败时的原因（不代表"父会话确实没有输入"）。 */
  errors: string[]
}

const EMPTY: AuxParentContextResult = buildAuxParentContext({ messages: [] })

/**
 * 取自父 runtime 的已提交活动分支。
 *
 * 为什么 `get_entries` 的返回天然等于"已提交"：pi 只在条目**追加**时写入会话管理器
 * （`message_end` / 工具结果落地），流式中的半轮根本没有条目。叠加 `leafId→parentId`
 * 回溯后，被 fork/编辑遗留的旁支也不会混进来。`live:true` 不是提交判据 —— 最终消息
 * 同样标 live，只有来源身份可靠。
 */
export async function collectAuxParentContext(
  deps: AuxContextCollectDeps,
  input: AuxContextCollectInput,
): Promise<AuxContextCollectResult> {
  const errors: string[] = []
  // 已接纳的 entry 身份：`get_entries` 返回的 id 集合就是"已提交"的权威定义。
  // 后两路也拿它过一遍（有 id 但不在集合里 = 未提交），三路的提交判据因此一致；
  // 这正是 "live:true 不作判据、只认来源身份" 的落点。
  let committedIds: Set<string> | undefined

  const entries = await deps.request({ type: "get_entries" }, input.parentRuntimeId).catch(error => {
    errors.push(error instanceof Error ? error.message : String(error))
    return null
  })
  if (entries?.success) {
    const data = entries.data as { entries?: unknown[]; leafId?: string | null } | undefined
    const raw = data?.entries ?? []
    committedIds = new Set(
      raw.map(entry => (entry as { id?: unknown })?.id).filter((id): id is string => typeof id === "string"),
    )
    const branch = activeBranchEntries(raw, data?.leafId ?? null)
    const messages = auxMessagesFromEntries(branch)
    const result = buildAuxParentContext({
      messages,
      streaming: input.streaming,
      committedIds,
      maxChars: deps.maxChars,
    })
    if (result.hasContext) return { ...result, source: "entries", errors }
  } else if (entries && !entries.success) errors.push(entries.error ?? "get_entries failed")

  const projection = await deps.request({ type: "get_messages" }, input.parentRuntimeId).catch(error => {
    errors.push(error instanceof Error ? error.message : String(error))
    return null
  })
  if (projection?.success) {
    const data = projection.data as { messages?: unknown[] } | undefined
    const result = buildAuxParentContext({
      messages: auxMessagesFromMessages(data?.messages ?? []),
      streaming: input.streaming,
      committedIds,
      maxChars: deps.maxChars,
    })
    if (result.hasContext) return { ...result, source: "messages", errors }
  } else if (projection && !projection.success) errors.push(projection.error ?? "get_messages failed")

  const file = input.sessionFile
  const readHistory = deps.readHistory
  if (file && readHistory) {
    // 已提交但文件暂不可读（`sessionFile` 已预留、还没落盘，实测存在）与读取竞态
    // 都落在这里：换下一路，而不是宣布"未取到父上下文"。
    const history = await readHistory(file).catch(error => {
      errors.push(error instanceof Error ? error.message : String(error))
      return null
    })
    if (history?.length) {
      const result = buildAuxParentContext({
        messages: auxMessagesFromMessages(history),
        streaming: input.streaming,
        committedIds,
        maxChars: deps.maxChars,
      })
      if (result.hasContext) return { ...result, source: "history", errors }
    }
  }

  return { ...EMPTY, source: "none", errors }
}
