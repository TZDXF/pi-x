/**
 * aux（辅助对话）父上下文的**取材**：从**父 runtime**（Main 策略）取已提交分支。
 *
 * 规格来源 `docs/aux-chat-spec.md` §3。三条来源按同一份归一化与截断规则收敛：
 * 1. 主路径 `get_entries`（父进程内存里**已追加**的条目，按 `leafId→parentId` 回溯活动分支）；
 * 2. 备选 `get_messages`（压缩投影语义）；
 * 3. 兜底 `session_history`（文件投影，Rust 侧已按 parentId 回溯活动分支）。
 *
 * 三条铁律：
 * - 查询**只打父 runtime**：`rpcRequest(command, parentRuntimeId)`。绝不通过 aux 网关
 *   去查父会话（aux 策略是 Aux、argv 带 `--no-session`，那里根本没有父会话）。
 * - **身份约束落到三路**：`get_entries` 成功且非空时它的 entry id 集合是三路的权威
 *   提交判据；拿不到权威集合（失败 / 空返回）时，另两路必须**来源自证**（每条消息
 *   自带 `_entryId`），无 id 的消息一律丢弃 —— 绝不"拿不到集合就当全部已提交"。
 * - 取材失败**不得**降级成"未取到父上下文"：只有"确实还没有已提交输入"才是空提示；
 *   某一路失败就换下一路，历史读取失败后还要**重取一次** `get_entries`（竞态常常
 *   在几百毫秒后就自愈），最后才承认拿不到。
 *
 * 成本如实：父上下文前缀在后续**每一轮**作为历史全价重发（`cacheWrite` 实测为 0），
 * 本模块不主张任何前缀缓存收益；32k 护栏正是为这个全价成本设的硬上限。
 *
 * `streaming` 由调用方给出（父会话是否在流式）。它决定截断锚点：流式中最后一条
 * 已提交 user 之后的 assistant/toolResult 属于**正在敲的半轮**，必须排除。
 */
import {
  activeBranchEntries,
  auxMessagesFromEntries,
  auxMessagesFromMessages,
  buildAuxParentContext,
  type AuxContextIdentity,
  type AuxContextMessage,
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

export interface AuxContextCollectResult {
  /** 折叠块原文（含标签）。 */
  block: string
  /** 折叠块内文（不含标签）；空提示时是 `AUX_PARENT_CONTEXT_EMPTY_NOTICE`。 */
  inner: string
  hasContext: boolean
  omittedGroups: number
  overLimit: boolean
  groupCount: number
  source: AuxContextSource
  /** 身份判据来源（权威集合 / 来源自证 / 没有可用身份）。 */
  identity: AuxContextIdentity
  /** 三路都失败时的原因（不代表"父会话确实没有输入"）。 */
  errors: string[]
  /** 诊断：实际发出的 RPC 类型与历史读取次数（测试钉"回落真的被调用"）。 */
  attempts: { entries: number; messages: number; history: number }
}

/**
 * 一次 `get_entries` 的结果。
 *
 * `committedIds` 只在**成功且非空**时给出：空返回意味着"此刻还没有已提交条目"，
 * 把它当成权威集合会过滤掉随后已落盘的文件内容（实测竞态），所以按"无权威集合"
 * 处理，由另两路自证身份。
 */
interface EntriesProbe {
  messages: AuxContextMessage[]
  committedIds: Set<string> | null
}

/** 读一次 `get_entries`；失败返回 `null` 并把原因写进 `errors`。 */
async function probeEntries(
  deps: AuxContextCollectDeps,
  input: AuxContextCollectInput,
  errors: string[],
): Promise<EntriesProbe | null> {
  const response = await deps.request({ type: "get_entries" }, input.parentRuntimeId).catch(error => {
    errors.push(error instanceof Error ? error.message : String(error))
    return null
  })
  if (!response) return null
  if (!response.success) {
    errors.push(response.error ?? "get_entries failed")
    return null
  }
  const data = response.data as { entries?: unknown[]; leafId?: string | null } | undefined
  const raw = data?.entries ?? []
  const ids = raw.map(entry => (entry as { id?: unknown })?.id).filter((id): id is string => typeof id === "string")
  return {
    messages: auxMessagesFromEntries(activeBranchEntries(raw, data?.leafId ?? null)),
    committedIds: ids.length ? new Set(ids) : null,
  }
}

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
  const attempts = { entries: 0, messages: 0, history: 0 }

  const build = (messages: readonly AuxContextMessage[], committedIds: ReadonlySet<string> | null) =>
    buildAuxParentContext({
      messages,
      streaming: input.streaming,
      // `null` ⇒ 无权威集合 ⇒ 另两路必须自证身份（实现里会丢弃无 id 的消息）。
      ...(committedIds ? { committedIds } : {}),
      maxChars: deps.maxChars,
    })

  attempts.entries++
  const first = await probeEntries(deps, input, errors)
  if (first) {
    const result = build(first.messages, first.committedIds)
    if (result.hasContext) return { ...result, source: "entries", identity: result.identity, errors, attempts }
  }

  attempts.messages++
  const projection = await deps.request({ type: "get_messages" }, input.parentRuntimeId).catch(error => {
    errors.push(error instanceof Error ? error.message : String(error))
    return null
  })
  if (projection?.success) {
    const data = projection.data as { messages?: unknown[] } | undefined
    const result = build(auxMessagesFromMessages(data?.messages ?? []), first?.committedIds ?? null)
    if (result.hasContext) return { ...result, source: "messages", identity: result.identity, errors, attempts }
  } else if (projection && !projection.success) errors.push(projection.error ?? "get_messages failed")

  const file = input.sessionFile
  const readHistory = deps.readHistory
  if (file && readHistory) {
    // 已提交但文件暂不可读（`sessionFile` 已预留、还没落盘，实测存在）与读取竞态
    // 都落在这里：换下一路（并在下面重取一次 `get_entries`），而不是宣布"未取到父上下文"。
    attempts.history++
    const history = await readHistory(file).catch(error => {
      errors.push(error instanceof Error ? error.message : String(error))
      return null
    })
    if (history?.length) {
      const result = build(auxMessagesFromMessages(history), first?.committedIds ?? null)
      if (result.hasContext) return { ...result, source: "history", identity: result.identity, errors, attempts }
    }
  }

  // 回落：历史返回 null / 抛错 / 被身份过滤空之后，**再取一次** `get_entries`。
  // 竞态常常在这几十毫秒里自愈（父进程刚把条目追加进会话管理器）；这也是规格
  // 明确要求的两条回落路径之一，不能直接源成"未取到父上下文"。
  attempts.entries++
  const retry = await probeEntries(deps, input, errors)
  if (retry) {
    const result = build(retry.messages, retry.committedIds)
    if (result.hasContext) return { ...result, source: "entries", identity: result.identity, errors, attempts }
  }

  const empty = build([], null)
  return { ...empty, source: "none", identity: empty.identity, errors, attempts }
}
