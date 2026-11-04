const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function localDayNumber(date: Date): number {
  // Compare calendar dates independently of 23/25-hour daylight-saving days.
  const day = new Date(0)
  day.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate())
  return day.getTime() / DAY
}

/** Compact local-time labels for Unix timestamps in milliseconds; now is supplied by the caller. */
export function formatKanbanTime(timestamp: number, locale: string, now: number, justNow: string): string | null {
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return null
  const date = new Date(timestamp)
  const current = new Date(now)
  if (Number.isNaN(date.getTime()) || Number.isNaN(current.getTime())) return null

  const difference = timestamp - now
  const elapsed = Math.abs(difference)
  if (elapsed < MINUTE) return justNow

  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "always" })
  const direction = difference < 0 ? -1 : 1
  if (elapsed < HOUR) return relative.format(direction * Math.floor(elapsed / MINUTE), "minute")

  const days = localDayNumber(date) - localDayNumber(current)
  if (days === 0) return relative.format(direction * Math.floor(elapsed / HOUR), "hour")
  if (days === -1 || days === 1) {
    const day = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(days, "day")
    const time = new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date)
    return `${day} ${time}`
  }
  if (Math.abs(days) < 7) return relative.format(days, "day")

  return new Intl.DateTimeFormat(locale, {
    ...(date.getFullYear() !== current.getFullYear() ? { year: "numeric" } : {}),
    month: "short",
    day: "numeric",
  }).format(date)
}
