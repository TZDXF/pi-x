import type { SessionMeta } from "@/api/piClient"

/** Preserve store ordering before applying search. Search never becomes the sortable model. */
export function sidebarSessionRows(
  sessions: SessionMeta[],
  archiving: Record<string, boolean>,
  query: string,
  label: (session: SessionMeta) => string,
) {
  return sessions.filter(
    session =>
      !session.archived &&
      !archiving[session.file] &&
      `${label(session)} ${session.id}`.toLowerCase().includes(query.toLowerCase()),
  )
}

/** Native setData is synchronous; Sortable's asynchronous start callback is too late. */
export function setSidebarSessionDragData(
  transfer: DataTransfer,
  item: HTMLElement,
  runtimeId: (file: string) => string | undefined,
) {
  const { file, path } = item.dataset
  if (!file || !path) return
  transfer.effectAllowed = "copyMove"
  transfer.setData("application/x-pix-session", file)
  transfer.setData("text/plain", file)
  transfer.setData("application/x-pix-session-drag", JSON.stringify({ file, path, runtimeId: runtimeId(file) }))
}
