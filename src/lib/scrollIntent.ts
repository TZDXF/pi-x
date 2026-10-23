/** Whether an upward wheel gesture can scroll the conversation viewport. */
export function shouldReleaseBottomLock(viewport: HTMLElement, target: Element | null, deltaY: number): boolean {
  if (deltaY >= 0 || viewport.scrollHeight <= viewport.clientHeight) return false

  let element = target
  while (element && element !== viewport) {
    const style = getComputedStyle(element)
    if ((style.overflowY === "auto" || style.overflowY === "scroll") && element.scrollHeight > element.clientHeight) {
      // A nested scroller consumes the gesture while it can move up, or when
      // its overscroll policy prevents chaining to the conversation.
      if (element.scrollTop > 0 || style.overscrollBehaviorY === "contain" || style.overscrollBehaviorY === "none")
        return false
    }
    element = element.parentElement
  }
  return element === viewport
}
