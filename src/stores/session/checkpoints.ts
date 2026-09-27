import { ref, watch, type Ref } from "vue"
import { sessionHistory } from "@/api/piClient"
import {
  createCheckpoint,
  diffCheckpoints,
  loadCheckpointManifest,
  saveCheckpointManifest,
  type TurnCheckpointRecord,
} from "@/lib/checkpoints"

export interface TurnCheckpointTracker {
  /** 已结算轮次的回滚记录（含文件差异），按用户消息时间戳关联。 */
  records: Ref<TurnCheckpointRecord[]>
  /** agent_start：轮开始快照；同一 user 轮的多段 run 只取第一段。 */
  onAgentStart: () => void
  /** agent_settled：结束快照 + diff + 写入清单。 */
  onAgentSettled: () => void
  /** 回滚成功后把该轮标记为已回滚并持久化。 */
  markReverted: (userTimestamp: number) => void
}

/**
 * 结合 pi 事件流的轮次 Git 快照编排（移植自 ZCode 的 checkpoint 设计）：
 * agent_start 时对工作区做隐藏 ref 快照，agent_settled 时再做一次并计算
 * 两者差异作为本轮文件修改；回滚即把工作区从结束态恢复到开始态。
 * 非 Git 项目等失败场景静默跳过，前端降级为工具参数回放回滚。
 */
export function createTurnCheckpoints(ctx: {
  cwd: Ref<string>
  sessionFile: Ref<string | null>
  /** 当前 user 轮次计数（agent_start 时已包含本轮 prompt）。 */
  userTurnCount: () => number
}): TurnCheckpointTracker {
  const records = ref<TurnCheckpointRecord[]>([])
  let startOid: string | null = null
  let startTurnIndex = -1
  let idSeq = 0
  let manifestSeq = 0

  // 会话切换（含 clear() 置空）时重置内存态并加载该会话的回滚清单。
  watch(ctx.sessionFile, file => {
    startOid = null
    const seq = ++manifestSeq
    records.value = []
    if (!file) return
    loadCheckpointManifest(file)
      .then(manifest => {
        if (seq === manifestSeq) records.value = manifest?.turns ?? []
      })
      .catch(() => { /* 清单缺失或损坏时按无记录处理 */ })
  }, { immediate: true })

  function persist() {
    const file = ctx.sessionFile.value
    if (!file) return
    const manifest = { version: 1 as const, turns: records.value }
    saveCheckpointManifest(file, manifest).catch(() => { /* 非致命：仅影响重开后的回滚 */ })
  }

  /** 结算后从会话文件取本轮用户消息的时间戳，作为跨重启的轮次匹配键。 */
  function resolveUserTimestamp(file: string): Promise<number | undefined> {
    return sessionHistory(file)
      .then(messages => {
        for (let index = messages.length - 1; index >= 0; index--) {
          const message = messages[index] as { role?: string, timestamp?: number } | undefined
          if (message?.role === "user") return typeof message.timestamp === "number" ? message.timestamp : undefined
        }
        return undefined
      })
      .catch(() => undefined)
  }

  function onAgentStart() {
    if (!ctx.sessionFile.value || startOid) return
    const project = ctx.cwd.value
    if (!project) return
    startTurnIndex = Math.max(0, ctx.userTurnCount() - 1)
    createCheckpoint(project, `turn-${Date.now()}-${++idSeq}`)
      .then(meta => { startOid = meta.commitOid })
      .catch(() => { startOid = null; startTurnIndex = -1 })
  }

  function onAgentSettled() {
    const project = ctx.cwd.value
    const file = ctx.sessionFile.value
    const from = startOid
    const turnIndex = startTurnIndex
    startOid = null
    startTurnIndex = -1
    if (!project || !file || !from) return
    const id = `turn-${Date.now()}-${++idSeq}`
    createCheckpoint(project, id)
      .then(end => diffCheckpoints(project, from, end.commitOid).then(files => ({ endOid: end.commitOid, files })))
      .then(({ endOid, files }) => {
        if (!files.length) return
        return resolveUserTimestamp(file).then(userTimestamp => ({ endOid, files, userTimestamp }))
      })
      .then(result => {
        if (!result) return
        const { endOid, files, userTimestamp } = result
        // 同一轮重复结算（重发/分支）以最新结果为准。
        records.value = [
          ...records.value.filter(record =>
            userTimestamp !== undefined
              ? record.userTimestamp !== userTimestamp
              : record.turnIndex !== turnIndex,
          ),
          { turnIndex, userTimestamp, startOid: from, endOid, state: "active", files },
        ]
        persist()
      })
      .catch(() => { /* 快照/差异失败：本轮仅失去回滚能力 */ })
  }

  function markReverted(userTimestamp: number) {
    const record = records.value.find(entry => entry.userTimestamp === userTimestamp && entry.state === "active")
    if (!record) return
    record.state = "reverted"
    persist()
  }

  return { records, onAgentStart, onAgentSettled, markReverted }
}
