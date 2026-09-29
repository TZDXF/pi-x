import { changedLines, type FileChange } from "@/lib/sessionChanges"
import { normalizeSlashes } from "@/lib/paths"
import type { Block, ToolRun } from "@/stores/session"
import type { RevertOp, TurnFileChange } from "@/lib/turnChanges"

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
  if (typeof data.toolCallId !== "string" || !data.toolCallId) return null

  const files = data.files.flatMap((file: any): FileChangeArtifactFile[] => {
    if (!file || typeof file !== "object" || typeof file.path !== "string" || !file.path.trim()) return []
    return [
      {
        path: normalizeSlashes(file.path),
        existedBefore: file.existedBefore === true,
        beforeContent: typeof file.beforeContent === "string" ? file.beforeContent : null,
        afterContent: typeof file.afterContent === "string" ? file.afterContent : null,
        beforeHash: typeof file.beforeHash === "string" ? file.beforeHash : null,
        afterHash: typeof file.afterHash === "string" ? file.afterHash : null,
        unsupportedReason: typeof file.unsupportedReason === "string" ? file.unsupportedReason : undefined,
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
    unknownBefore: false,
  }
}

/** Replace tool-argument snippets with exact artifact diffs for covered calls. */
export function mergeArtifactChanges(fallback: FileChange[], artifacts: FileChangeArtifact[]): FileChange[] {
  if (!artifacts.length) return fallback
  const covered = new Set(artifacts.map(artifact => artifact.toolCallId))
  const retained = fallback.filter(change => !covered.has(change.id.split(":")[0] ?? ""))
  const exact = artifacts.flatMap(artifact =>
    artifact.files.map((file, index) => fileChangeFromArtifact(artifact, file, index)),
  )
  return [...retained, ...exact]
}

function revertOpForFile(file: FileChangeArtifactFile): RevertOp | null {
  if (file.unsupportedReason) return null
  if (file.afterContent === null) return null
  if (!file.existedBefore || file.beforeContent === null) return { kind: "delete", content: file.afterContent }
  return { kind: "restore", before: file.afterContent, after: file.beforeContent }
}

/** Build the per-turn summary from exact before/after artifacts. */
export function turnFileChangesFromArtifacts(
  blocks: Block[],
  runs: Record<string, ToolRun>,
  artifacts: FileChangeArtifact[],
): TurnFileChange[] {
  const ids = new Set(
    blocks.flatMap(block =>
      block.type === "toolCall" && runs[block.callId]?.state === "output-available" ? [block.callId] : [],
    ),
  )
  const byPath = new Map<string, TurnFileChange>()
  const beforeByPath = new Map<string, string>()
  const afterByPath = new Map<string, string>()
  for (const artifact of artifacts) {
    if (!ids.has(artifact.toolCallId)) continue
    for (const file of artifact.files) {
      const existing = byPath.get(file.path)
      const op = revertOpForFile(file)
      if (existing) {
        existing.unknown ||= !!file.unsupportedReason
        if (op) existing.ops.push(op)
        else existing.revertible = false
        afterByPath.set(file.path, file.afterContent ?? "")
        continue
      }
      beforeByPath.set(file.path, file.beforeContent ?? "")
      afterByPath.set(file.path, file.afterContent ?? "")
      byPath.set(file.path, {
        path: file.path,
        added: 0,
        removed: 0,
        unknown: !!file.unsupportedReason,
        ops: op ? [op] : [],
        revertible: !!op,
      })
    }
  }
  for (const [path, file] of byPath) {
    const lines = changedLines(beforeByPath.get(path) ?? "", afterByPath.get(path) ?? "")
    file.added = lines.filter(line => line.kind === "add").length
    file.removed = lines.filter(line => line.kind === "remove").length
  }
  return [...byPath.values()]
}
