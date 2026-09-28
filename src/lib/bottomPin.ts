/**
 * Synchronously glue a scroller to its bottom while content grows.
 *
 * vue-stick-to-bottom applies resize corrections in a requestAnimationFrame
 * callback, so every streaming chunk paints one frame with a stale scrollTop
 * before snapping back (the scrollbar visibly bounces). Calling this from a
 * ResizeObserver callback instead - after layout, before paint - keeps the
 * thumb fixed at the bottom.
 *
 * Returns whether the scroll position changed.
 */
export function pinToBottom(
  viewport: { scrollTop: number; scrollHeight: number; clientHeight: number },
  atBottom: boolean,
  escaped: boolean,
): boolean {
  if (!atBottom || escaped) return false
  const max = viewport.scrollHeight - viewport.clientHeight
  if (max <= 0 || viewport.scrollTop >= max) return false
  viewport.scrollTop = max
  return true
}
