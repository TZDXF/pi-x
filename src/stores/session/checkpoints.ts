import { ref, watch, type Ref } from "vue"
import {
  createCheckpoint,
  deleteCheckpoint,
  diffCheckpoints,
  loadCheckpointManifest,
  saveCheckpointManifest,
  type TurnCheckpointRecord,
} from "@/lib/checkpoints"

export interface TurnCheckpointTracker {
  /** 已结算轮次的回滚记录（含文件差异），按 turnIndex 关联。 */
  records: Ref<TurnCheckpointRecord[]>
  /** agent_start：轮开始快照；同一 user 轮的多段 run 只取第一段。 */
  onAgentStart: () => void
  /** agent_settled：结束快照 + diff + 写入清单。 */
  onAgentSettled: () => void
  /** 回滚成功后把该轮标记为已回滚并持久化。 */
  markReverted: (turnIndex: number) => void
  /** 清理旧的 checkpoint refs，只保留最近的 N 个（对齐 ZCode 的清理机制）。 */
  cleanupOldCheckpoints?: (keepCount?: number) => Promise<void>
}

/**
 * 结合 pi 事件流的轮次 Git 快照编排（移植自 ZCode 的 checkpoint 设计）：
 * agent_start 时对工作区做隐藏 ref 快照，agent_settled 时再做一次并计算
 * 两者差异作为本轮文件修改；回滚即把工作区从结束态恢复到开始态。
 * 非 Git 项目等失败场景静默跳过，前端降级为工具参数回放回滚。
 *
 * 对齐 ZCode 的改进：
 * 1. 添加 deleteCheckpoint API
 * 2. 添加定期清理机制（cleanupOldCheckpoints）
 * 3. 使用隐藏 ref 前缀（refs/pix-internal/checkpoints）
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
  watch(
    ctx.sessionFile,
    file => {
      startOid = null
      const seq = ++manifestSeq
      records.value = []
      if (!file) return
      loadCheckpointManifest(file)
        .then(manifest => {
          if (seq === manifestSeq) records.value = manifest?.turns ?? []
        })
        .catch(() => {
          /* 清单缺失或损坏时按无记录处理 */
        })
    },
    { immediate: true },
  )

  function persist() {
    const file = ctx.sessionFile.value
    if (!file) return
    const manifest = { version: 1 as const, turns: records.value }
    saveCheckpointManifest(file, manifest).catch(() => {
      /* 非致命：仅影响重开后的回滚 */
    })
  }

  function onAgentStart() {
    if (!ctx.sessionFile.value || startOid) return
    const project = ctx.cwd.value
    if (!project) return
    const file = ctx.sessionFile.value
    startTurnIndex = Math.max(0, ctx.userTurnCount() - 1)
    createCheckpoint(project, `turn-${Date.now()}-${++idSeq}`)
      .then(meta => {
        if (ctx.sessionFile.value === file) startOid = meta.commitOid
      })
      .catch(() => {
        if (ctx.sessionFile.value === file) {
          startOid = null
          startTurnIndex = -1
        }
      })
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
      .then(end => {
        if (ctx.sessionFile.value !== file) return null
        return diffCheckpoints(project, from, end.commitOid).then(files => ({
          endOid: end.commitOid,
          files,
          checkpointId: id,
        }))
      })
      .then(result => {
        if (!result || ctx.sessionFile.value !== file) return
        const { endOid, files, checkpointId } = result
        if (!files.length) return
        // 同一轮重复结算（重发/分支）以最新结果为准。
        records.value = [
          ...records.value.filter(record => record.turnIndex !== turnIndex),
          { turnIndex, checkpointId, startOid: from, endOid, state: "active", files },
        ]
        persist()
      })
      .catch(() => {
        /* 快照/差异失败：本轮仅失去回滚能力 */
      })
  }

  function markReverted(turnIndex: number) {
    const record = records.value.find(entry => entry.turnIndex === turnIndex && entry.state === "active")
    if (!record) return
    record.state = "reverted"
    persist()
  }

  /**
   * 清理旧的 checkpoint refs，只保留最近的 N 个（对齐 ZCode 的清理机制）。
   * 这可以防止 checkpoint 提交无限累积，保持 Git 仓库整洁。
   */
  async function cleanupOldCheckpoints(keepCount: number = 10): Promise<void> {
    const project = ctx.cwd.value
    if (!project || records.value.length <= keepCount) return

    // 按时间排序，保留最近的 keepCount 个
    const sorted = [...records.value].sort((a, b) => {
      const aTime = a.userTimestamp ?? 0
      const bTime = b.userTimestamp ?? 0
      return bTime - aTime
    })
    const toDelete = sorted.slice(keepCount)

    // 并行删除旧的 checkpoint refs
    await Promise.allSettled(
      toDelete.map(record =>
        record.checkpointId ? deleteCheckpoint(project, record.checkpointId) : Promise.resolve(),
      ),
    )

    // 从 records 中移除
    const deleteSet = new Set(toDelete.map(r => r.turnIndex))
    records.value = records.value.filter(r => !deleteSet.has(r.turnIndex))
    persist()
  }

  return { records, onAgentStart, onAgentSettled, markReverted, cleanupOldCheckpoints }
}
