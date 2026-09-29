import { watch } from "vue"
import { useI18n } from "vue-i18n"
import type { SessionStore } from "@/stores/session"
import type { UiStore } from "@/stores/ui"
import type { AssistantTurn } from "@/lib/responseTurns"
import { turnFileChanges, type TurnFileChange } from "@/lib/turnChanges"
import { turnFileChangesFromArtifacts } from "@/lib/fileChangeArtifacts"
import type { TurnCheckpointRecord } from "@/lib/checkpoints"
import { formatCodedError } from "@/lib/backendError"
import type { RevertFileResult } from "@/lib/revertChanges"

/**
 * Per-turn file changes (summary card with git revert). Streaming re-renders
 * this list constantly; the cache keeps the line diffs from being recomputed
 * while the turn's calls and their run states stand still.
 */
export function useTurnChanges(session: SessionStore, ui: UiStore) {
  const { t } = useI18n()
  const cache = new Map<number, { signature: string; files: TurnFileChange[] }>()

  /** 渲染轮次对应的用户消息 turnIndex，与会话清单里的快照记录精确匹配。 */
  function turnUserTurnIndex(entry: AssistantTurn): number | undefined {
    for (let index = Math.min(entry.lastIndex, session.entries.length - 1); index >= 0; index--) {
      const candidate = session.entries[index]
      if (candidate?.kind === "user") return candidate.turnIndex
    }
    return undefined
  }

  function checkpointForTurn(entry: AssistantTurn): TurnCheckpointRecord | null {
    const turnIndex = turnUserTurnIndex(entry)
    if (turnIndex === undefined) return null
    return session.turnCheckpointRecords.find(record => record.turnIndex === turnIndex) ?? null
  }

  function changesForTurn(entry: AssistantTurn): TurnFileChange[] {
    // Built-in file-change tracking records exact before/after content around
    // write/edit calls. Prefer it over reconstructed snippets or turn snapshots.
    const exact = turnFileChangesFromArtifacts(entry.blocks, session.runs, session.fileChangeArtifacts)
    if (exact.length) return exact
    // 有 Git 快照记录的轮次以快照差异为准（覆盖 bash 等工具的文件修改）。
    const checkpoint = checkpointForTurn(entry)
    if (checkpoint)
      return checkpoint.files.map(file => ({
        path: file.path,
        added: file.added,
        removed: file.removed,
        unknown: false,
        ops: [],
        revertible: true,
      }))
    const signature = entry.blocks
      .flatMap(block =>
        block.type === "toolCall"
          ? [`${block.callId}:${block.argsText.length}:${session.runs[block.callId]?.state ?? "-"}`]
          : [],
      )
      .join("|")
    const hit = cache.get(entry.id)
    if (hit && hit.signature === signature) return hit.files
    const files = turnFileChanges(entry.blocks, session.runs)
    cache.set(entry.id, { signature, files })
    return files
  }

  function artifactsForTurn(entry: AssistantTurn) {
    const ids = new Set(entry.blocks.flatMap(block => (block.type === "toolCall" ? [block.callId] : [])))
    return session.fileChangeArtifacts.filter(artifact => ids.has(artifact.toolCallId))
  }

  function onTurnReverted(results: RevertFileResult[]) {
    const ok = results.filter(result => result.ok).length
    if (ok) ui.pushToast(t("turnChanges.toastReverted", { count: ok }), "info")
    for (const result of results) if (!result.ok) ui.pushToast(formatCodedError(t, result.error ?? ""), "error")
  }

  function onTurnRevertedAll(entry: AssistantTurn) {
    const artifacts = artifactsForTurn(entry)
    if (artifacts.length) void session.markFileRewinds(artifacts.map(artifact => artifact.toolCallId))
    const checkpoint = checkpointForTurn(entry)
    if (checkpoint) session.markTurnReverted(checkpoint.turnIndex)
  }

  function turnArtifactsReverted(entry: AssistantTurn): boolean {
    const artifacts = artifactsForTurn(entry)
    return artifacts.length > 0 && artifacts.every(artifact => session.revertedFileChangeCalls.has(artifact.toolCallId))
  }

  watch(
    () => session.sessionFile,
    () => cache.clear(),
  )

  return {
    changesForTurn,
    artifactsForTurn,
    checkpointForTurn,
    onTurnReverted,
    onTurnRevertedAll,
    turnArtifactsReverted,
  }
}
