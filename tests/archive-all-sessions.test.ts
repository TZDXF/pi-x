import { expect, test, vi } from "vitest"
import type { SessionMeta } from "@/api/piClient"
import { useArchiveAllSessions } from "@/composables/useArchiveAllSessions"

const saved = (file = "one", extra: Partial<SessionMeta> = {}): SessionMeta => ({
  file,
  id: `id-${file}`,
  cwd: "project",
  mtimeMs: 0,
  title: file,
  ...extra,
})

test("archive all preserves titles, skips archived/duplicate rows and continues after failures", async () => {
  const sessions = [saved("first"), saved("second", { title: null }), saved("archived", { archived: true })]
  const update = vi.fn(async (session: SessionMeta, _title: string | null, archived: boolean) => {
    if (session.file === "second") throw new Error("archive failed")
    session.archived = archived
  })
  const { archivingAll, archiveAll } = useArchiveAllSessions(update)

  const pending = archiveAll([...sessions, sessions[0]!])
  expect(archivingAll.value).toBe(true)
  await expect(pending).resolves.toEqual({ total: 2, failed: 1 })
  expect(update.mock.calls).toEqual([
    [sessions[0], "first", true],
    [sessions[1], null, true],
  ])
  expect(sessions[0]!.archived).toBe(true)
  expect(sessions[1]!.archived).toBeUndefined()
  expect(sessions[2]!.archived).toBe(true)
  expect(archivingAll.value).toBe(false)
})

test("archive all blocks re-entry and resets its busy state", async () => {
  let finish!: () => void
  const update = vi.fn(
    () =>
      new Promise<void>(resolve => {
        finish = resolve
      }),
  )
  const { archivingAll, archiveAll } = useArchiveAllSessions(update)
  const pending = archiveAll([saved("first")])
  await expect(archiveAll([saved("second")])).resolves.toEqual({ total: 0, failed: 0 })
  expect(update).toHaveBeenCalledExactlyOnceWith(saved("first"), "first", true)
  finish()
  await pending
  expect(archivingAll.value).toBe(false)
})

test("archive all reports each failed row to the caller and keeps going", async () => {
  const errors: unknown[] = []
  const update = vi.fn(async (session: SessionMeta) => {
    if (session.file === "second") throw new Error("archive failed")
  })
  const { archiveAll } = useArchiveAllSessions(update, error => errors.push(error))
  await expect(archiveAll([saved("first"), saved("second"), saved("third")])).resolves.toEqual({
    total: 3,
    failed: 1,
  })
  expect(update).toHaveBeenCalledTimes(3)
  expect(errors).toHaveLength(1)
  expect(String(errors[0])).toBe("Error: archive failed")
})
