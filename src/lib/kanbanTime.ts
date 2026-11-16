const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function localDayNumber(date: Date): number {
  // Compare calendar dates independently of 23/25-hour daylight-saving days.
  const day = new Date(0)
  day.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate())
  return day.getTime() / DAY
}

/** Friendly elapsed time for an active turn; clock skew is clamped to zero. */
export function formatKanbanDuration(startedAt: number, now: number, locale: string): string | null {
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return null
  const totalSeconds = Math.floor(Math.max(0, now - startedAt) / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const unit = (value: number, name: "hour" | "minute" | "second") =>
    new Intl.NumberFormat(locale, { style: "unit", unit: name, unitDisplay: "long" }).format(value)
  const separator = locale.toLowerCase().startsWith("zh") ? "" : " "
  if (hours) return [unit(hours, "hour"), minutes ? unit(minutes, "minute") : ""].filter(Boolean).join(separator)
  if (minutes) return [unit(minutes, "minute"), seconds ? unit(seconds, "second") : ""].filter(Boolean).join(separator)
  return unit(seconds, "second")
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
