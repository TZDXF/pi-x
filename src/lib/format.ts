import { currentLocale } from "@/i18n"

const formatterCache = new Map<string, Intl.NumberFormat>()

function cachedNumberFormatter(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const locale = currentLocale()
  const key = `${locale}:${JSON.stringify(options)}`
  let formatter = formatterCache.get(key)
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options)
    formatterCache.set(key, formatter)
  }
  return formatter
}

/** Compact counts (tokens, downloads); follows the active UI locale. */
export function compactNumber(n: number): string {
  return cachedNumberFormatter({ notation: "compact" }).format(n)
}

/** Percentages (cache hit rate, context usage); follows the active UI locale. */
export function formatPercent(n: number): string {
  return cachedNumberFormatter({ style: "percent", maximumFractionDigits: 1 }).format(n)
}

/** Message timestamps: time only for today, otherwise a short date plus time. */
export function formatMessageTime(ts?: number): string {
  if (!ts) return ""
  const d = new Date(ts)
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  if (d.toDateString() === new Date().toDateString()) return time
  return `${d.toLocaleDateString([], { month: "numeric", day: "numeric" })} ${time}`
}

/** Absolute timestamps for schedule/archive lists. */
export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString()
}

/** Relative "updated N ago" labels; wall-clock based. */
export function formatRelativeTime(ms: number): string {
  if (!ms) return ""
  const diff = Date.now() - ms
  const rtf = new Intl.RelativeTimeFormat(currentLocale(), { numeric: "auto" })
  const days = Math.round(diff / 86400000)
  if (days < 1) return rtf.format(-Math.max(1, Math.round(diff / 3600000)), "hour")
  if (days < 30) return rtf.format(-days, "day")
  const months = Math.round(days / 30)
  if (months < 12) return rtf.format(-months, "month")
  return rtf.format(-Math.round(months / 12), "year")
}
