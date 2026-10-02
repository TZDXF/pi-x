import type { QueuedPrompt } from "@/stores/session"
import { sendCountdown } from "@/lib/sendCountdown"

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
