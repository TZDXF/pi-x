import type { Ref } from "vue"
import { fileChangeArtifactFromEntry, type FileChangeArtifact } from "@/lib/fileChangeArtifacts"
import { fileRewindState, markFileRewindState } from "@/lib/fileRewind"

interface ArtifactsContext {
  sessionFile: Ref<string | null>
  fileChangeArtifacts: Ref<FileChangeArtifact[]>
  revertedFileChangeCalls: Ref<Set<string>>
}

/** File-change artifacts collected from custom entries, plus the persisted
 *  rewind markers that say which of their tool calls have been reverted. */
export function createSessionArtifacts(context: ArtifactsContext) {
  const { sessionFile, fileChangeArtifacts, revertedFileChangeCalls } = context

  async function refreshFileRewindState(file: string | null) {
    if (!file) return
    try {
      const ids = await fileRewindState(file)
      if (sessionFile.value === file) revertedFileChangeCalls.value = new Set(ids)
    } catch {
      /* Optional persisted UI state. */
    }
  }

  async function markFileRewinds(toolCallIds: string[]) {
    const file = sessionFile.value
    if (!file || !toolCallIds.length) return
    try {
      const ids = await markFileRewindState(file, toolCallIds)
      if (sessionFile.value === file) revertedFileChangeCalls.value = new Set(ids)
    } catch {
      /* The actual file rewind already succeeded. */
    }
  }

  function mergeFileChangeArtifact(entry: unknown) {
    const artifact = fileChangeArtifactFromEntry(entry)
    if (!artifact) return
    const key = `${artifact.entryId ?? ""}:${artifact.toolCallId}`
    const index = fileChangeArtifacts.value.findIndex(item => `${item.entryId ?? ""}:${item.toolCallId}` === key)
    fileChangeArtifacts.value =
      index >= 0
        ? fileChangeArtifacts.value.map((item, i) => (i === index ? artifact : item))
        : [...fileChangeArtifacts.value, artifact]
  }

  return { refreshFileRewindState, markFileRewinds, mergeFileChangeArtifact }
}
