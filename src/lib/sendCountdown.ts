/** Use wall-clock time so suspended/background clients catch up on the next tick. */
export function sendCountdown(sendAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((sendAt - now) / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
}
