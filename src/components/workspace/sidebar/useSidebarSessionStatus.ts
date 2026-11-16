import type { QueuedPrompt } from "@/stores/session"
import type { SessionMeta } from "@/api/piClient"
import { sendCountdown } from "@/lib/sendCountdown"
import { samePath } from "@/lib/paths"
import { sessionRunStatus } from "@/stores/sessionRunStatus"

export function sidebarQueueTitle(
  queue: QueuedPrompt[] | undefined,
  now: number,
  queuedLabel: string,
  countdownLabel: (time: string) => string,
) {
  const nextSendAt =
    queue?.reduce(
      (earliest, item) => (item.sendAt === undefined ? earliest : Math.min(earliest, item.sendAt)),
      Infinity,
    ) ?? Infinity
  return Number.isFinite(nextSendAt)
    ? `${queuedLabel} · ${countdownLabel(sendCountdown(nextSendAt, now))}`
    : queuedLabel
}

export function projectHasRunningSession(
  path: string,
  rows: Pick<SessionMeta, "file">[],
  conversations: { cwd: string; isStreaming: boolean }[],
  projectRoot: (path: string) => string,
) {
  return (
    rows.some(row => sessionRunStatus(row.file, path) === "running") ||
    conversations.some(conversation => conversation.isStreaming && samePath(projectRoot(conversation.cwd), path))
  )
}
