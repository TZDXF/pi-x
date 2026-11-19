/**
 * Attribute scroll events to whoever really moved the viewport (TZD-135).
 *
 * The conversation viewport is moved by code that is not the reader: bottom
 * pinning while a reply streams, virtual-row height compensation
 * (`VirtualMessage.measure`), history page anchoring, message navigation, and
 * the storage library's own clamps. Every one of them surfaces as an ordinary
 * scroll event, so the scroll handler cannot tell whether the position changed
 * because someone scrolled.
 *
 * Reading an app write as a downward gesture is what made the panel jump to the
 * bottom while the user was scrolling up: one such write lands on the bottom,
 * bottom following is re-armed, and from then on every streaming chunk pins the
 * viewport there, so the reader can never stay scrolled up.
 *
 * Three inputs decide the attribution, and the reader always wins:
 *
 * 1. **Observed writes.** The viewport's `scrollTop` is observed: an assignment
 *    made outside user input records the position the browser settled on, and
 *    the scroll event it causes consumes that record.
 * 2. **User input dispatches.** A wheel, a key or a scrollbar pointer interaction
 *    opens a short window (`beginUserInput`); writes inside it are the reader's
 *    and are not recorded. This is what keeps Reka honest — its scrollbar listens
 *    for `wheel` on the document and positions the thumb by assigning
 *    `scrollTop`, so neither reaches the viewport's own handlers. A thumb merely
 *    held still opens no window, so later compensation writes stay app writes.
 * 3. **App-initiated scrolling.** `scrollTo()`/`scrollBy()` and
 *    `scrollIntoView()` never touch the accessor, so `beginAppScroll` marks the
 *    viewport: its scroll events stay app-owned until the movement settles.
 */

interface AppScroll {
  startedAt: number
  lastEventAt: number
}

interface ScrollWrite {
  scrollTop: number
  at: number
}

/** How long a recorded write may take to surface as a scroll event. */
const WRITE_TTL_MS = 400
/** How long user input keeps owning the writes it dispatches. */
const INPUT_WINDOW_MS = 48
/** Quiet period after which an app-initiated scroll counts as settled. */
const APP_SCROLL_SETTLE_MS = 160
/** Hard cap, so a stalled smooth scroll cannot own the viewport forever. */
const APP_SCROLL_MAX_MS = 1600
/** Sub-pixel layout rounding must not unmatch a recorded write. */
const TOLERANCE_PX = 1

const writes = new WeakMap<object, ScrollWrite[]>()
const inputUntil = new WeakMap<object, number>()
const appScrolls = new WeakMap<object, AppScroll>()

/** Whether the reader's own input currently owns this viewport's writes. */
export function isUserInputActive(target: object, now = Date.now()): boolean {
  const until = inputUntil.get(target)
  if (until === undefined) return false
  if (until > now) return true
  inputUntil.delete(target)
  return false
}

/**
 * Open a short window owned by the reader.
 *
 * Call it from the input dispatch itself. The window covers the rest of that
 * dispatch plus the scroll event it produces, so a later compensation write
 * while the reader only holds the thumb still is attributed to the app.
 * Pending app records and an app-initiated scroll are dropped — the reader wins.
 */
export function beginUserInput(target: object, now = Date.now()): void {
  inputUntil.set(target, now + INPUT_WINDOW_MS)
  writes.delete(target)
  appScrolls.delete(target)
}

/** Close the window early, once the input has been fully handled. */
export function endUserInput(target: object): void {
  inputUntil.delete(target)
}

/** Record that a scroll event at `scrollTop` was produced by code. */
export function recordScrollWrite(target: object, scrollTop: number, now = Date.now()): void {
  // Inside user input the movement is the reader's: leaving it unrecorded is
  // exactly what makes the resulting scroll event count as a gesture.
  if (isUserInputActive(target, now)) return
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

/** Forget records: a real gesture outranks anything still pending. */
export function clearScrollWrites(target: object): void {
  writes.delete(target)
}

/**
 * Declare that this viewport scrolls because the app asked it to.
 *
 * `scrollTo()`, `scrollBy()` and `scrollIntoView()` (smooth or not) never touch
 * the `scrollTop` accessor, so their events cannot be matched to a record.
 * Marking the viewport keeps them — including the final one clamped onto the
 * bottom — out of the reading-intent decision until the movement settles.
 */
export function beginAppScroll(target: object, now = Date.now()): void {
  appScrolls.set(target, { startedAt: now, lastEventAt: now })
}

/** End an app-initiated scroll early (e.g. the reader took over). */
export function endAppScroll(target: object): void {
  appScrolls.delete(target)
}

/**
 * Whether the viewport is still inside an app-initiated scroll.
 *
 * Every scroll event refreshes the quiet period; once the movement stops for
 * `APP_SCROLL_SETTLE_MS` (or the `APP_SCROLL_MAX_MS` cap is hit) the viewport is
 * the reader's again.
 */
export function isAppScrolling(target: object, now = Date.now()): boolean {
  const state = appScrolls.get(target)
  if (!state) return false
  if (now - state.lastEventAt > APP_SCROLL_SETTLE_MS || now - state.startedAt > APP_SCROLL_MAX_MS) {
    appScrolls.delete(target)
    return false
  }
  state.lastEventAt = now
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
    inputUntil.delete(target)
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
