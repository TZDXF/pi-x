/** A layout shrink clamps scrollTop to the new bottom without a reading gesture. */
export function shouldReleaseBottomLockOnScroll(
  previousScrollTop: number,
  scrollTop: number,
  maxScrollTop: number,
): boolean {
  // vue-stick-to-bottom targets max - 1, so allow its one-pixel correction too.
  return scrollTop < previousScrollTop && scrollTop < maxScrollTop - 1
}

/**
 * Only a genuine downward reading gesture may re-enable bottom following.
 *
 * The caller decides whether the movement belongs to the reader at all (see
 * `lib/scrollWrites`); this function answers the geometric remainder.
 */
export function shouldResumeBottomLock(
  previousScrollTop: number,
  scrollTop: number,
  maxScrollTop: number,
  readingHistory: boolean,
): boolean {
  return readingHistory && scrollTop > previousScrollTop && scrollTop >= maxScrollTop - 1
}

/**
 * Whether this event target scrolls the conversation viewport itself.
 *
 * Two shapes are relevant: anything inside the viewport, and the conversation's
 * own scrollbar. The scrollbar is the viewport's **sibling** (Reka renders it
 * next to the viewport inside `ScrollAreaRoot`), so a wheel over the track never
 * reaches the viewport's own listener — Reka handles it with a document-level
 * listener that writes `viewport.scrollTop` directly.
 */
export function targetsConversationViewport(viewport: HTMLElement, target: Element | null): boolean {
  if (!target) return false
  if (viewport.contains(target)) return true
  // Detached targets (no owner tree) cannot be part of the conversation.
  if (typeof target.closest !== "function") return false
  const scrollbar = target.closest('[data-slot="scroll-area-scrollbar"]')
  // Only the viewport's own scrollbar: its parent is the same ScrollAreaRoot.
  return !!scrollbar && scrollbar.parentElement === viewport.parentElement
}

/** Keys whose default action scrolls the conversation. */
const KEY_SCROLL_KEYS = new Set(["End", "Home", "PageDown", "PageUp", "ArrowDown", "ArrowUp", " "])

/**
 * Whether this key press scrolls the conversation viewport.
 *
 * Keys scroll the nearest scrollable ancestor of the focused element, so focus
 * has to be inside the conversation. Space is the exception: it activates the
 * focused control (a button, a summary, a checkbox) instead of scrolling, so it
 * only scrolls when the viewport itself holds focus.
 */
export function keyScrollsConversation(viewport: HTMLElement, event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return false
  if (!(event.target instanceof Element) || !targetsConversationViewport(viewport, event.target)) return false
  if (!KEY_SCROLL_KEYS.has(event.key)) return false
  return event.key !== " " || event.target === viewport
}

/**
 * Whether a gesture in `deltaY`'s direction moves the conversation viewport,
 * rather than being consumed by a nested scroller.
 *
 * Reka renders the conversation viewport as `overflow: hidden scroll`, which the
 * storage library's shorthand `overflow` check misses. A nested scroller (a long
 * thinking block, a code block, a file tree) swallows the gesture while it can
 * still move that way.
 */
export function canScrollConversation(viewport: HTMLElement, target: Element | null, deltaY: number): boolean {
  if (deltaY === 0 || viewport.scrollHeight <= viewport.clientHeight) return false
  if (!targetsConversationViewport(viewport, target)) return false
  // The conversation's own scrollbar always drives the viewport.
  if (!viewport.contains(target!)) return true
  const down = deltaY > 0

  let element: Element | null = target
  while (element && element !== viewport) {
    const style = getComputedStyle(element)
    if ((style.overflowY === "auto" || style.overflowY === "scroll") && element.scrollHeight > element.clientHeight) {
      const canMove = down ? element.scrollTop < element.scrollHeight - element.clientHeight : element.scrollTop > 0
      // A nested scroller consumes the gesture while it can still move, or when
      // its overscroll policy prevents chaining to the conversation.
      if (canMove || style.overscrollBehaviorY === "contain" || style.overscrollBehaviorY === "none") return false
    }
    element = element.parentElement
  }
  return element === viewport
}

/** Whether an upward wheel gesture can scroll the conversation viewport. */
export function shouldReleaseBottomLock(viewport: HTMLElement, target: Element | null, deltaY: number): boolean {
  return deltaY < 0 && canScrollConversation(viewport, target, deltaY)
}
