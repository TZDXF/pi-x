import { changedLines, type FileChange } from "@/lib/sessionChanges"
import { normalizeSlashes } from "@/lib/paths"
import type { Block, ToolRun } from "@/stores/session"
import type { TurnFileChange } from "@/lib/turnChanges"

/** One file snapshot captured before and after a pi write/edit tool call. */
export interface FileChangeArtifactFile {
  path: string
  existedBefore: boolean
  beforeContent: string | null
  afterContent: string | null
  beforeHash?: string | null
  afterHash?: string | null
  unsupportedReason?: string
}

export interface FileChangeArtifact {
  version: 1
  createdAt?: string
  toolCallId: string
  toolName: string
  entryId?: string
  files: FileChangeArtifactFile[]
}

/** Parse either a persisted custom session entry or an RPC entry_appended payload. */
export function fileChangeArtifactFromEntry(entry: any): FileChangeArtifact | null {
  if (!entry || typeof entry !== "object") return null
  const customType = entry.customType ?? entry.entry?.customType
  if (customType !== "pix-file-change") return null
  const data = entry.data ?? entry.entry?.data
  if (!data || typeof data !== "object" || !Array.isArray(data.files)) return null
  if (data.version !== undefined && data.version !== 1) return null
  if (typeof data.toolCallId !== "string" || !data.toolCallId) return null

  const files = data.files.flatMap((file: any): FileChangeArtifactFile[] => {
    if (!file || typeof file !== "object" || typeof file.path !== "string" || !file.path.trim()) return []
    const complete =
      typeof file.existedBefore === "boolean" &&
      (typeof file.beforeContent === "string" || file.beforeContent === null) &&
      (typeof file.afterContent === "string" || file.afterContent === null) &&
      file.existedBefore === (file.beforeContent !== null)
    return [
      {
        path: normalizeSlashes(file.path),
        existedBefore: file.existedBefore === true,
        beforeContent: typeof file.beforeContent === "string" ? file.beforeContent : null,
        afterContent: typeof file.afterContent === "string" ? file.afterContent : null,
        beforeHash: typeof file.beforeHash === "string" ? file.beforeHash : null,
        afterHash: typeof file.afterHash === "string" ? file.afterHash : null,
        unsupportedReason:
          typeof file.unsupportedReason === "string" && file.unsupportedReason
            ? file.unsupportedReason
            : complete
              ? undefined
              : "incomplete_artifact",
      },
    ]
  })
  if (!files.length) return null

  return {
    version: 1,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : undefined,
    toolCallId: data.toolCallId,
    toolName: typeof data.toolName === "string" ? data.toolName : "tool",
    entryId:
      typeof (entry._entryId ?? entry.id ?? entry.entry?.id) === "string"
        ? String(entry._entryId ?? entry.id ?? entry.entry?.id)
        : undefined,
    files,
  }
}

/** Convert one artifact operation into the diff shape used by the review panel. */
export function fileChangeFromArtifact(
  artifact: FileChangeArtifact,
  file: FileChangeArtifactFile,
  index: number,
): FileChange {
  const before = file.beforeContent ?? ""
  const after = file.afterContent ?? ""
  const lines = changedLines(before, after)
  return {
    id: `artifact:${artifact.entryId ?? artifact.toolCallId}:${index}`,
    path: file.path,
    tool: artifact.toolName,
    lines,
    added: lines.filter(line => line.kind === "add").length,
    removed: lines.filter(line => line.kind === "remove").length,
    unknownBefore: !!file.unsupportedReason,
  }
}

/** Replace tool-argument snippets with exact artifact diffs for covered calls. */
export function mergeArtifactChanges(fallback: FileChange[], artifacts: FileChangeArtifact[]): FileChange[] {
  const tracked = artifacts.filter(artifact => !isShellFileChange(artifact.toolName))
  if (!tracked.length) return fallback
  const covered = new Set(tracked.map(artifact => artifact.toolCallId))
  const retained = fallback.filter(change => !covered.has(change.id.split(":")[0] ?? ""))
  const exact = tracked.flatMap(artifact =>
    artifact.files.map((file, index) => fileChangeFromArtifact(artifact, file, index)),
  )
  return [...retained, ...exact]
}

/** 与后端一致：终端操作不是可精确归属的文件修改记录。 */
export function isShellFileChange(toolName: string): boolean {
  const normalized = toolName.toLowerCase().replace(/[^a-z0-9]/g, "")
  return (
    normalized === "bash" || normalized === "shell" || normalized.includes("terminal") || normalized.endsWith("shell")
  )
}

export function artifactsForToolCalls(
  blocks: Block[],
  runs: Record<string, ToolRun>,
  artifacts: FileChangeArtifact[],
): FileChangeArtifact[] {
  const ids = new Set(
    blocks.flatMap(block =>
      block.type === "toolCall" && !isShellFileChange(block.name) && runs[block.callId]?.state === "output-available"
        ? [block.callId]
        : [],
    ),
  )
  const byCall = new Map<string, FileChangeArtifact>()
  for (const artifact of artifacts) {
    if (ids.has(artifact.toolCallId) && !isShellFileChange(artifact.toolName)) byCall.set(artifact.toolCallId, artifact)
  }
  return [...byCall.values()].sort((left, right) => {
    const first = Date.parse(left.createdAt ?? "")
    const second = Date.parse(right.createdAt ?? "")
    return Number.isFinite(first) && Number.isFinite(second) ? first - second : 0
  })
}

/** 同一文件保留首次 before 与最终 after，摘要只计算净变化。 */
export function turnFileChangesFromArtifacts(
  blocks: Block[],
  runs: Record<string, ToolRun>,
  artifacts: FileChangeArtifact[],
): TurnFileChange[] {
  const byPath = new Map<
    string,
    { file: TurnFileChange; before: string; after: string; beforeExists: boolean; afterExists: boolean }
  >()
  for (const artifact of artifactsForToolCalls(blocks, runs, artifacts)) {
    for (const file of artifact.files) {
      const unsupported = !!file.unsupportedReason || (file.existedBefore && file.beforeContent === null)
      const existing = byPath.get(file.path)
      if (existing) {
        // 两次工具操作之间发生过外部修改时，不能把不连续的内容当成一条可撤销链。
        existing.file.unknown ||=
          unsupported || existing.after !== (file.beforeContent ?? "") || existing.afterExists !== file.existedBefore
        existing.file.revertible = !existing.file.unknown
        existing.after = file.afterContent ?? ""
        existing.afterExists = file.afterContent !== null
      } else {
        byPath.set(file.path, {
          file: { path: file.path, added: 0, removed: 0, unknown: unsupported, revertible: !unsupported },
          before: file.beforeContent ?? "",
          after: file.afterContent ?? "",
          beforeExists: file.existedBefore,
          afterExists: file.afterContent !== null,
        })
      }
    }
  }
  return [...byPath.values()].flatMap(({ file, before, after, beforeExists, afterExists }) => {
    const lines = changedLines(before, after)
    file.added = lines.filter(line => line.kind === "add").length
    file.removed = lines.filter(line => line.kind === "remove").length
    return before !== after || beforeExists !== afterExists || file.unknown ? [file] : []
  })
}
