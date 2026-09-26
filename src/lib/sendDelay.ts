/** Parse a minutes:seconds delay, matching the countdown shown in the queue. */
export function parseSendDelay(value: string): number | null {
  const match = /^(\d+):([0-5]\d)$/.exec(value.trim())
  if (!match) return null
  const minutes = Number(match[1])
  const seconds = Number(match[2])
  const delayMs = (minutes * 60 + seconds) * 1000
  return Number.isFinite(delayMs) && delayMs > 0 && delayMs <= 365 * 24 * 60 * 60 * 1000 ? delayMs : null
}

/** A hovered delay segment can scroll without focusing the input. Ignore sideways swipes. */
export function stepSendDelayWheel(value: number | null, deltaY: number, deltaX: number, max: number): number | null {
  if (!Number.isFinite(deltaY) || Math.abs(deltaY) <= Math.abs(deltaX)) return null
  return Math.max(0, Math.min(max, (value ?? 0) + (deltaY < 0 ? 1 : -1)))
}
