/**
 * Tell an app-driven scroll write apart from a reading gesture (TZD-135).
 *
 * The conversation viewport is moved by code that is not the reader: bottom
 * pinning while a reply streams, virtual-row height compensation
 * (`VirtualMessage.measure`), history page anchoring, the storage library's own
 * shrink clamp and its correction when growing content arrives. Every one of
 * them surfaces as an ordinary scroll event, so the scroll handler cannot tell
 * whether the position changed because someone scrolled.
 *
 * Reading a downward write as a downward gesture is what made the panel jump to
 * the bottom while the user was scrolling up: one of those writes lands on the
 * bottom, bottom following is re-armed, and from then on every streaming chunk
 * pins the viewport there, so the reader can never stay scrolled up.
 *
 * The viewport's `scrollTop` is therefore observed: each assignment made by code
 * records the position the browser settled on, and the scroll event it causes
 * consumes that record. A real gesture clears the records first, so the reader
 * always wins — including a scrollbar drag, whose thumb is also positioned by
 * code.
 */

interface ScrollWrite {
  scrollTop: number
  at: number
}

/** How long a recorded write may take to surface as a scroll event. */
const SCROLL_WRITE_TTL_MS = 400
/** Sub-pixel layout rounding must not unmatch a recorded write. */
const SCROLL_WRITE_TOLERANCE_PX = 1

const writes = new WeakMap<object, ScrollWrite[]>()
const dragging = new WeakSet<object>()

/** Record that a scroll event at `scrollTop` was produced by code. */
export function recordScrollWrite(target: object, scrollTop: number, now = Date.now()): void {
  if (dragging.has(target)) return
  const list = writes.get(target)
  if (!list) {
    writes.set(target, [{ scrollTop, at: now }])
    return
  }
  for (let index = list.length - 1; index >= 0; index--) {
    if (now - list[index]!.at > SCROLL_WRITE_TTL_MS) list.splice(index, 1)
  }
  list.push({ scrollTop, at: now })
}

/**
 * Whether this scroll event matches a recorded write, consuming that record.
 *
 * A write that produced no event (the browser clamped it, or the position did
 * not change) simply expires; repeated writes queue up independently.
 */
export function consumeScrollWrite(target: object, scrollTop: number, now = Date.now()): boolean {
  const list = writes.get(target)
  if (!list) return false
  for (let index = list.length - 1; index >= 0; index--) {
    if (now - list[index]!.at > SCROLL_WRITE_TTL_MS) list.splice(index, 1)
  }
  const index = list.findIndex(write => Math.abs(write.scrollTop - scrollTop) <= SCROLL_WRITE_TOLERANCE_PX)
  if (index < 0) return false
  list.splice(index, 1)
  return true
}

/** A real gesture wins over stale records: nothing pending belongs to it. */
export function clearScrollWrites(target: object): void {
  writes.delete(target)
}

/**
 * Stop recording writes while a scrollbar drag is in progress.
 *
 * The custom scrollbar's thumb follows the pointer by assigning `scrollTop`, so
 * that movement is the reader's, not the app's.
 */
export function beginScrollDrag(target: object): void {
  dragging.add(target)
  writes.delete(target)
}

/** Resume recording once the drag ends. */
export function endScrollDrag(target: object): void {
  dragging.delete(target)
}

/**
 * Record every `scrollTop` assignment on `target` as programmatic.
 *
 * Installed on the conversation viewport so bottom pinning, virtual-row
 * compensation, history anchoring and the storage library's internal writes are
 * all covered without each writer declaring itself.
 *
 * Returns a disposer restoring the previous property descriptor.
 */
export function observeScrollWrites(target: HTMLElement): () => void {
  const own = Object.getOwnPropertyDescriptor(target, "scrollTop")
  const inherited = findAccessor(Object.getPrototypeOf(target), "scrollTop")
  let fallback = target.scrollTop

  const read = (): number => {
    if (own?.get) return own.get.call(target)
    if (inherited?.get) return inherited.get.call(target)
    return fallback
  }
  const write = (value: number) => {
    if (own?.set) own.set.call(target, value)
    else if (inherited?.set) inherited.set.call(target, value)
    else fallback = value
  }

  Object.defineProperty(target, "scrollTop", {
    configurable: true,
    enumerable: own?.enumerable ?? inherited?.enumerable ?? true,
    get: read,
    set(value: number) {
      write(value)
      // Record the settled position: a clamped write surfaces its scroll event
      // at the clamped value, not at the requested one.
      recordScrollWrite(target, read())
    },
  })

  return () => {
    if (own) Object.defineProperty(target, "scrollTop", own)
    else Reflect.deleteProperty(target, "scrollTop")
    writes.delete(target)
    dragging.delete(target)
  }
}

function findAccessor(start: object | null, key: string): PropertyDescriptor | undefined {
  let proto = start
  while (proto) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, key)
    if (descriptor) return descriptor
    proto = Object.getPrototypeOf(proto)
  }
  return undefined
}
