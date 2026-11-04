/** Keep malformed key events away from app and third-party keyboard listeners. */
export function ignoreInvalidKeyboardEvent(event: Event) {
  if (!("key" in event) || typeof event.key !== "string" || !event.key) {
    event.stopImmediatePropagation()
  }
}
