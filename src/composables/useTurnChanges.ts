import { watch } from "vue"
import { useI18n } from "vue-i18n"
import type { SessionStore } from "@/stores/session"
import type { UiStore } from "@/stores/ui"
import type { AssistantTurn } from "@/lib/responseTurns"
import { turnFileChanges, type TurnFileChange } from "@/lib/turnChanges"
import { artifactsForToolCalls, turnFileChangesFromArtifacts } from "@/lib/fileChangeArtifacts"
import { formatCodedError } from "@/lib/backendError"
import type { FileRewindFileResult } from "@/lib/fileRewind"

/** 以成功工具调用的稳定 ID 关联文件记录；不依赖轮次计数或 Git 状态。 */
export function useTurnChanges(session: SessionStore, ui: UiStore) {
  const { t } = useI18n()
  const cache = new Map<number, { signature: string; files: TurnFileChange[] }>()

  function allArtifactsForTurn(entry: AssistantTurn) {
    return artifactsForToolCalls(entry.blocks, session.runs, session.fileChangeArtifacts)
  }

  function changesForTurn(entry: AssistantTurn): TurnFileChange[] {
    const artifacts = allArtifactsForTurn(entry)
    // 有精确记录时只展示可归属的真实修改，终端和外部工作区变化不参与摘要。
    if (artifacts.length) return turnFileChangesFromArtifacts(entry.blocks, session.runs, artifacts)
    const signature = entry.blocks
      .flatMap(block =>
        block.type === "toolCall"
          ? [`${block.callId}:${block.argsText}:${session.runs[block.callId]?.state ?? "-"}`]
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
    return allArtifactsForTurn(entry).filter(artifact => !session.revertedFileChangeCalls.has(artifact.toolCallId))
  }

  function onTurnReverted(results: FileRewindFileResult[]) {
    const ok = results.filter(result => result.ok).length
    if (ok) ui.pushToast(t("turnChanges.toastReverted", { count: ok }), "info")
    for (const result of results) if (!result.ok) ui.pushToast(formatCodedError(t, result.error ?? ""), "error")
  }

  function onTurnRevertedAll(file: string | null, toolCallIds: string[]) {
    session.recordFileRewinds(file, toolCallIds)
  }

  function turnArtifactsReverted(entry: AssistantTurn): boolean {
    const artifacts = allArtifactsForTurn(entry)
    return artifacts.length > 0 && artifacts.every(artifact => session.revertedFileChangeCalls.has(artifact.toolCallId))
  }

  watch(
    () => session.sessionFile,
    () => cache.clear(),
  )

  return {
    changesForTurn,
    artifactsForTurn,
    onTurnReverted,
    onTurnRevertedAll,
    turnArtifactsReverted,
  }
}
