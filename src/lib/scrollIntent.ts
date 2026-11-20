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
const KEY_SCROLL_KEYS = new Set(["End", "Home", "PageDown", "PageUp", "ArrowDown", "ArrowUp"])
/** Keys that only move a caret when the focus is in a text field. */
const CARET_KEYS = new Set(["End", "Home", "ArrowDown", "ArrowUp"])

/** Whether this element takes arrow keys as caret movement, not scrolling. */
export function isTextEntry(target: Element): boolean {
  const element = target as HTMLElement
  const tag = element.tagName
  if (tag === "TEXTAREA") return true
  if (tag === "INPUT") {
    // Non-text inputs (range, checkbox, …) do not move a caret.
    const type = (element as HTMLInputElement).type
    return type === "" || type === "text" || type === "search" || type === "url" || type === "email" || type === "tel"
  }
  return element.isContentEditable === true
}

/**
 * Whether this key press scrolls the **conversation** viewport.
 *
 * A key scrolls the nearest scrollable ancestor of whatever holds focus. So a key
 * only counts when the focus is inside the conversation **and** no nested scroller
 * between it and the viewport can still move that way: pressing ArrowDown inside
 * an independently scrollable block must not be taken as the reader taking over
 * the conversation (TZD-135 review).
 *
 * Space is not a scroll key here: it activates the focused control (a button, a
 * summary, a checkbox), which is why it used to launder the layout write that
 * followed the keystroke.
 *
 * Anchors and arrows inside a text field move the caret instead of scrolling, so
 * the inline prompt editor (or any other textarea) must not be read as the
 * reader taking over the conversation (TZD-135 review).
 */
export function keyScrollsConversation(viewport: HTMLElement, event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return false
  const target = event.target
  if (!(target instanceof Element) || !viewport.contains(target)) return false
  const key = event.key
  if (!KEY_SCROLL_KEYS.has(key)) return false
  if (CARET_KEYS.has(key) && isTextEntry(target)) return false
  const down = key === "End" || key === "PageDown" || key === "ArrowDown"

  let element: Element | null = target
  while (element && element !== viewport) {
    const style = getComputedStyle(element)
    if ((style.overflowY === "auto" || style.overflowY === "scroll") && element.scrollHeight > element.clientHeight) {
      const canMove = down ? element.scrollTop < element.scrollHeight - element.clientHeight : element.scrollTop > 0
      // The nested scroller consumes the key while it can still move, or when its
      // overscroll policy prevents chaining to the conversation.
      if (canMove || style.overscrollBehaviorY === "contain" || style.overscrollBehaviorY === "none") return false
    }
    element = element.parentElement
  }
  return element === viewport
}

/**
 * Whether a touch starting at `target` scrolls the conversation **itself**.
 *
 * A finger inside a nested scroller (a code block, a file tree, a tall preview)
 * pans that scroller; the conversation only moves once the nested one is exhausted
 * and its overscroll policy allows chaining. Treating such a gesture as the reader
 * taking the conversation over is wrong (TZD-135 review), so the gesture is only
 * claimed when nothing between the target and the viewport can scroll vertically.
 */
export function touchScrollsConversation(viewport: HTMLElement, target: Element | null): boolean {
  if (!target || !viewport.contains(target)) return false
  if (viewport.scrollHeight <= viewport.clientHeight) return false
  let element: Element | null = target
  while (element && element !== viewport) {
    const style = getComputedStyle(element)
    if ((style.overflowY === "auto" || style.overflowY === "scroll") && element.scrollHeight > element.clientHeight)
      return false
    element = element.parentElement
  }
  return element === viewport
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
