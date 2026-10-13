import type { Ref } from "vue"
import { fileChangeArtifactFromEntry, type FileChangeArtifact } from "@/lib/fileChangeArtifacts"
import { fileRewindState } from "@/lib/fileRewind"

interface ArtifactsContext {
  sessionFile: Ref<string | null>
  fileChangeArtifacts: Ref<FileChangeArtifact[]>
  revertedFileChangeCalls: Ref<Set<string>>
}

/** File-change artifacts collected from custom entries, plus the persisted
 *  rewind markers that say which of their tool calls have been reverted. */
export function createSessionArtifacts(context: ArtifactsContext) {
  const { sessionFile, fileChangeArtifacts, revertedFileChangeCalls } = context
  let rewindStateSeq = 0

  async function refreshFileRewindState(file: string | null) {
    if (!file) return
    const seq = ++rewindStateSeq
    try {
      const ids = await fileRewindState(file)
      if (sessionFile.value === file && seq === rewindStateSeq) revertedFileChangeCalls.value = new Set(ids)
    } catch {
      /* Optional persisted UI state. */
    }
  }

  /** 后端已持久化成功的撤销，只更新所属会话的内存状态。 */
  function recordFileRewinds(file: string | null, toolCallIds: string[]) {
    if (file !== sessionFile.value) return
    ++rewindStateSeq
    revertedFileChangeCalls.value = new Set([...revertedFileChangeCalls.value, ...toolCallIds])
  }

  function mergeFileChangeArtifact(entry: unknown) {
    const artifact = fileChangeArtifactFromEntry(entry)
    if (!artifact) return
    const index = fileChangeArtifacts.value.findIndex(item => item.toolCallId === artifact.toolCallId)
    fileChangeArtifacts.value =
      index >= 0
        ? fileChangeArtifacts.value.map((item, i) => (i === index ? artifact : item))
        : [...fileChangeArtifacts.value, artifact]
  }

  return { refreshFileRewindState, recordFileRewinds, mergeFileChangeArtifact }
}
