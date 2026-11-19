/**
 * Attribute scroll events to whoever really moved the viewport (TZD-135).
 *
 * The conversation viewport is moved by code that is not the reader: bottom
 * pinning while a reply streams, virtual-row height compensation
 * (`VirtualMessage.measure`), history page anchoring, message navigation, and the
 * storage library's own clamps. Every one of them surfaces as an ordinary scroll
 * event, so the scroll handler cannot tell whether the position changed because
 * someone scrolled.
 *
 * Reading an app write as a downward gesture is what made the panel jump to the
 * bottom while the user was scrolling up: one such write lands on the bottom,
 * bottom following is re-armed, and from then on every streaming chunk pins the
 * viewport there, so the reader can never stay scrolled up.
 *
 * Attribution has two inputs:
 *
 * 1. **Observed writes.** The viewport's `scrollTop` is observed. An assignment
 *    made outside an input dispatch records the position the browser settled on,
 *    and the scroll event it causes consumes that record.
 * 2. **Input dispatches.** An input that moves the viewport *itself* (a wheel, a
 *    scrolling key, a scrollbar pointer interaction) opens an exemption that
 *    covers exactly that input's dispatch — the whole task the browser dispatches
 *    the event in, including the library listeners that run after ours. Only
 *    writes performed within that task are the reader's; a layout write that
 *    merely *follows* the input in a later task stays the app's.
 *
 *    This is what keeps Reka honest — its scrollbar listens for `wheel` on the
 *    document and positions the thumb by assigning `scrollTop`, so neither
 *    reaches the viewport's own handlers — while a same-frame compensation
 *    triggered by the same keystroke is no longer swallowed.
 *
 * App-initiated scrolling (`scrollTo`, `scrollBy`, `scrollIntoView`) never touches
 * the accessor, so its events cannot be matched to a record. `beginAppScroll`
 * marks the viewport with the position the app asked for, and the mark stays
 * until the movement is **confirmed** finished: the arrival event at that
 * position, the browser's `scrollend`, a replacement request, or the reader
 * actually taking the viewport over. A timeout never stands in for that
 * confirmation — a busy frame can delay the first frame of an animation by
 * hundreds of milliseconds, and the arrival would then be attributed to the
 * reader.
 */

interface AppScroll {
  /** Position the app asked for, clamped to the scrollable range; null if unknown. */
  targetTop: number | null
}

interface ScrollWrite {
  scrollTop: number
  at: number
}

/** How long a recorded write may take to surface as a scroll event. */
const WRITE_TTL_MS = 400
/** Sub-pixel layout rounding must not unmatch a recorded write or a target. */
const TOLERANCE_PX = 1

const writes = new WeakMap<object, ScrollWrite[]>()
/** Input dispatches currently executing for this viewport (nested ones count). */
const dispatches = new WeakMap<object, number>()
const appScrolls = new WeakMap<object, AppScroll>()

/** Whether an input dispatch for this viewport is running right now. */
export function isInputDispatch(target: object): boolean {
  return (dispatches.get(target) ?? 0) > 0
}

/**
 * Open an exemption for the input dispatch that is running now.
 *
 * The exemption ends when the browser finishes dispatching this event — i.e. at
 * the end of the current task, after every listener of the same event ran. A
 * write the dispatch itself performs (Reka's thumb write for a wheel over the
 * track or a pointer drag) is the reader's; a layout write in a later task
 * belongs to the app.
 */
export function beginUserInput(target: object): void {
  dispatches.set(target, (dispatches.get(target) ?? 0) + 1)
  // The reader outranks anything the app still has pending for this viewport.
  writes.delete(target)
  setTimeout(() => {
    const remaining = (dispatches.get(target) ?? 1) - 1
    if (remaining > 0) dispatches.set(target, remaining)
    else dispatches.delete(target)
  }, 0)
}

/** Close the exemption early, once the dispatch is known to be finished. */
export function endUserInput(target: object): void {
  dispatches.delete(target)
}

/** Record that a scroll event at `scrollTop` was produced by code. */
export function recordScrollWrite(target: object, scrollTop: number, now = Date.now()): void {
  // A write the input dispatch performs itself is the reader's: leaving it
  // unrecorded is what makes the resulting scroll event count as a gesture.
  if (isInputDispatch(target)) return
  const list = writes.get(target)
  if (!list) {
    writes.set(target, [{ scrollTop, at: now }])
    return
  }
  for (let index = list.length - 1; index >= 0; index--) {
    if (now - list[index]!.at > WRITE_TTL_MS) list.splice(index, 1)
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
    if (now - list[index]!.at > WRITE_TTL_MS) list.splice(index, 1)
  }
  const index = list.findIndex(write => Math.abs(write.scrollTop - scrollTop) <= TOLERANCE_PX)
  if (index < 0) return false
  list.splice(index, 1)
  return true
}

/** Forget records: a fresh start (new input, new navigation) outranks them. */
export function clearScrollWrites(target: object): void {
  writes.delete(target)
}

/**
 * Declare that this viewport scrolls because the app asked it to.
 *
 * `targetTop` is the position the app requested, clamped by the caller; reaching
 * it is the app's own confirmation that the movement finished. Pass `null` when
 * the movement has no known endpoint (`scrollIntoView`) and let `scrollend`, a
 * replacement request or a reader takeover finish it.
 */
export function beginAppScroll(target: object, targetTop: number | null): void {
  appScrolls.set(target, { targetTop })
}

/**
 * End an app-initiated scroll: the browser reported `scrollend`, the request was
 * cancelled or replaced, or the reader took the viewport over.
 */
export function finishAppScroll(target: object): void {
  appScrolls.delete(target)
}

/** Whether the app is still waiting for the movement it asked for. */
export function hasAppScroll(target: object): boolean {
  return appScrolls.has(target)
}

/**
 * Whether the viewport still owes the app the movement it asked for.
 *
 * The event that lands on the requested position is the app's own arrival: it is
 * attributed to the app and then the viewport is handed back to the reader.
 */
export function isAppScrolling(target: object, scrollTop: number): boolean {
  const state = appScrolls.get(target)
  if (!state) return false
  if (state.targetTop !== null && Math.abs(state.targetTop - scrollTop) <= TOLERANCE_PX) appScrolls.delete(target)
  return true
}

/**
 * Record every `scrollTop` assignment on `target` as programmatic.
 *
 * Installed on the conversation viewport so bottom pinning, virtual-row
 * compensation, history anchoring and the storage library's internal writes are
 * all covered without each writer declaring itself.
 *
 * Returns a disposer restoring the previous property descriptor and dropping all
 * attribution state for that viewport.
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
    dispatches.delete(target)
    appScrolls.delete(target)
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
