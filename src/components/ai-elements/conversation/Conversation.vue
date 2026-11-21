<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
import { reactiveOmit } from '@vueuse/core'
import { useStickToBottom } from 'vue-stick-to-bottom'
import { nextTick, onBeforeUnmount, onMounted, provide, ref, watch, watchEffect } from 'vue'
import { ScrollAreaRoot, ScrollAreaViewport } from 'reka-ui'
import { ScrollBar } from '@/components/ui/scroll-area'
import { pinToBottom } from '@/lib/bottomPin'
import {
  canScrollConversation,
  keyScrollsConversation,
  shouldReleaseBottomLockOnScroll,
  shouldResumeBottomLock,
  touchScrollsConversation,
  TOUCH_SCROLL_CLAIM_PX,
  travelClaims,
} from '@/lib/scrollIntent'
import type { InputScopeCloser } from '@/lib/scrollWrites'
import {
  appScrollHasMoved,
  beginAppScroll,
  beginUserInput,
  consumeScrollWrite,
  finishAppScroll,
  isAppScrolling,
  observeScrollWrites,
} from '@/lib/scrollWrites'
import { conversationKey } from './context'

interface Props {
  ariaLabel?: string
  class?: HTMLAttributes['class']
  initial?: boolean | 'instant' | { damping?: number, stiffness?: number, mass?: number }
  resize?: 'instant' | { damping?: number, stiffness?: number, mass?: number }
  damping?: number
  stiffness?: number
  mass?: number
  anchor?: 'auto' | 'none'
}

const emit = defineEmits<{ scroll: [event: Event] }>()
defineExpose({
  stopScroll: releaseBottomLock,
  scrollToBottom,
  scrollToMessage,
})

const props = withDefaults(defineProps<Props>(), {
  ariaLabel: 'Conversation',
  initial: true,
  damping: 0.7,
  stiffness: 0.05,
  mass: 1.25,
  anchor: 'none',
})
const delegatedProps = reactiveOmit(props, 'class', 'ariaLabel', 'anchor')
const context = useStickToBottom(delegatedProps)
const { scrollRef, contentRef } = context
const viewport = ref<InstanceType<typeof ScrollAreaViewport>>()
let readingHistory = props.initial === false
let lastScrollTop: number | undefined
function releaseBottomLock() {
  readingHistory = true
  context.stopScroll()
}
function scrollToBottom(options?: Parameters<typeof context.scrollToBottom>[0]) {
  readingHistory = false
  return context.scrollToBottom(options)
}
/**
 * Scroll to a message, keeping the movement attributable to the app until it is
 * confirmed finished (TZD-135).
 *
 * `scrollTo()` bypasses the `scrollTop` accessor, so observed writes cannot cover
 * it. The requested position is handed over as the confirmation target: the
 * arrival at that position ends the attribution, as does `scrollend` or an actual
 * takeover by the reader. A timeout is deliberately not used — a busy frame can
 * delay the first animation frame by hundreds of milliseconds, and cutting the
 * attribution there would attribute the arrival to the reader.
 */
async function scrollToMessage(id: number) {
  const scroll = scrollRef.value
  const message = scroll?.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
  if (!scroll || !message) return
  releaseBottomLock()
  message.dispatchEvent(new Event('virtual-reveal'))
  await nextTick()
  if (!message.isConnected) return
  const requested = scroll.scrollTop + message.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 24
  // The browser clamps the request; that is the position the arrival reports.
  const max = scroll.scrollHeight - scroll.clientHeight
  const targetTop = Math.max(0, Math.min(requested, max))
  const instant = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  // A request already satisfied produces neither `scroll` nor `scrollend`, so it
  // must not leave an attribution mark behind (TZD-135 review). `beginAppScroll`
  // reports whether there is anything to wait for.
  // A new navigation replaces any earlier gesture's claim and candidate.
  touchScrolled = false
  touchCandidate = false
  touchPointerId = undefined
  if (!beginAppScroll(scroll, targetTop, scroll.scrollTop)) return
  scroll.scrollTo({ top: requested, behavior: instant ? 'instant' : 'smooth' })
  // Instant scrolling settles inside this task, but its `scroll` event still
  // arrives afterwards: the mark stays and the arrival consumes it.
}
watchEffect(() => { scrollRef.value = viewport.value?.viewportElement ?? null })
watch(() => ({ ...delegatedProps }), options => context.setOptions(options))
// The library clears escapedFromLock when shrinking near the bottom. Keep the
// user's reading intent authoritative so our instant resize pin cannot re-lock.
// Run after its whole resize callback: isAtBottom also includes "near bottom",
// so a synchronous watcher cannot observe the internal at-bottom change.
watch(() => context.escapedFromLock.value, escaped => {
  if (readingHistory && !escaped) context.stopScroll()
})
/**
 * Reka positions the scrollbar thumb by assigning `scrollTop` from its own
 * listeners: a `wheel` listener on `document`, and pointer handlers on the
 * scrollbar. Those writes are the reader's, but they never reach ours.
 *
 * So each relevant input is bracketed by a capture listener (open) and a bubble
 * listener (close) of the *same* event. The exemption then lasts exactly the
 * browser's dispatch of that input — which is when Reka writes — and never into
 * the rendering step, where a layout write belongs to the app (TZD-135 review).
 * Only this conversation's own scrollbar counts: its parent is the same
 * ScrollAreaRoot, so a nested or unrelated one cannot claim the reader.
 */
function ownScrollbar(target: Element): boolean {
  const scroll = scrollRef.value
  if (!scroll) return false
  const scrollbar = target.closest('[data-slot="scroll-area-scrollbar"]')
  return !!scrollbar && scrollbar.parentElement === scroll.parentElement
}
/**
 * The touch gesture, if any, that is scrolling **this** conversation.
 *
 * A gesture is only the reader's once it actually moved **this viewport**.
 * Pointer coordinates prove nothing: a sideways swipe, a three-pixel wobble and a
 * diagonal pan inside a horizontal-only block all move the finger without moving
 * the conversation, and platforms zero out the coordinates of a `pointercancel`.
 * So no claim is ever derived from pointer displacement, single or accumulated.
 *
 * What is tracked instead:
 *
 * - the `pointerId` of a press that started on the conversation itself
 *   (`touchScrollsConversation` keeps vertically scrollable nested blocks out);
 * - `touchCandidate`, armed when the browser cancels **that** pointer. A cancel
 *   means "the browser took the touch over for scrolling", but says nothing about
 *   *what* scrolled — an inner horizontal block cancels too — so it is only a
 *   candidate, and the claim still waits for the conversation to move.
 *
 * The claim itself is decided in `handleScroll`, on the viewport's own vertical
 * travel from `touchStartTop`, for a scroll no app write accounts for: a live
 * press still yields to an app navigation in flight (an animation moves the
 * viewport under a resting finger), while a candidate may override it — the
 * browser already cancelled the animation, so a stale mark must not block a real
 * drag.
 */
let touchPointerId: number | undefined
/** Viewport position when the tracked touch started. */
let touchStartTop = 0
/** The browser cancelled a tracked touch and now drives the scrolling itself. */
let touchCandidate = false
/** Viewport position at the moment the tracked gesture was cancelled. */
let touchCandidateTop = 0
/**
 * Vertical direction the tracked finger travelled (+1 down, -1 up, 0 none).
 *
 * Only a *corroboration*, never a claim by itself: the reader drags the content
 * with the finger, so the viewport has to move the opposite way. A sideways swipe
 * has no vertical direction, and an app animation that keeps running after some
 * unrelated gesture moves the viewport without matching the finger — both are
 * exactly the cases where claiming would end a navigation the reader never took
 * over (TZD-135 review).
 */
let touchTravelDirection = 0
/** The tracked gesture has been attributed to the reader. */
let touchScrolled = false
/** Closers of the exemptions opened by the input currently being dispatched. */
let wheelScope: InputScopeCloser | undefined
let keyScope: InputScopeCloser | undefined
let pointerScope: InputScopeCloser | undefined
function handleWheelCapture(event: WheelEvent) {
  const scroll = scrollRef.value
  if (!scroll || event.ctrlKey || !(event.target instanceof Element)) return
  // Reka uses overflow: hidden scroll, which the library's shorthand overflow
  // check misses. Release before virtual row resizing can pin us back down.
  if (!canScrollConversation(scroll, event.target, event.deltaY)) return
  wheelScope = beginUserInput(scroll)
  // Another input ends a pending touch candidate: that gesture is over.
  touchCandidate = false
  // The reader outranks an app navigation still in flight.
  finishAppScroll(scroll)
  if (event.deltaY < 0) releaseBottomLock()
}
function handleKeyDownCapture(event: KeyboardEvent) {
  const scroll = scrollRef.value
  // A key only counts when it scrolls *this* viewport: a nested independently
  // scrollable region consumes it, and Space activates the focused control
  // instead of scrolling at all (TZD-135 review).
  if (!scroll || !keyScrollsConversation(scroll, event)) return
  keyScope = beginUserInput(scroll)
  // Another input ends a pending touch candidate: that gesture is over.
  touchCandidate = false
  finishAppScroll(scroll)
}
function handlePointerCapture(event: PointerEvent) {
  const scroll = scrollRef.value
  if (!scroll || !(event.target instanceof Element)) return
  if (event.type === "pointerdown" && event.pointerType === "touch") {
    // Track only gestures the conversation itself could be scrolling: a press on
    // a nested scroller pans that block, not the conversation.
    touchPointerId = touchScrollsConversation(scroll, event.target) ? event.pointerId : undefined
    touchStartTop = scroll.scrollTop
    touchCandidate = false
    touchScrolled = false
    touchTravelDirection = 0
  } else if (event.type === "pointermove" && event.pointerType === "touch" && event.pointerId === touchPointerId) {
    // Fingers moving up (negative movementY) scroll the content down, and vice
    // versa; remember which way the tracked gesture goes.
    const movement = event.movementY || 0
    if (movement !== 0) touchTravelDirection = movement > 0 ? 1 : -1
  }
  if (event.type !== "pointerdown" && event.type !== "pointermove") return
  if (!ownScrollbar(event.target)) return
  pointerScope = beginUserInput(scroll)
  if (event.type === "pointerdown") finishAppScroll(scroll)
}
/**
 * The tracked touch scrolled the conversation, so it cancels any programmatic
 * animation and owns the scrolls that follow it.
 */
function claimTouchGesture(scroll: HTMLElement) {
  touchScrolled = true
  touchCandidate = false
  finishAppScroll(scroll)
}
function handlePointerRelease(event: PointerEvent) {
  const scroll = scrollRef.value
  if (event.pointerType === "touch" && event.pointerId === touchPointerId) {
    // `pointercancel` for the tracked pointer means the browser took the touch
    // over and drives the scrolling itself — but it says nothing about *what*
    // scrolled (an inner horizontal block cancels too, and its coordinates may
    // arrive zeroed). So it only arms a candidate; the claim still waits for the
    // conversation to actually move (TZD-135 review).
    if (event.type === "pointercancel" && scroll) {
      touchCandidate = true
      touchCandidateTop = scroll.scrollTop
    }
    touchPointerId = undefined
  }
  endPointerScope()
}
function endPointerScope() {
  pointerScope?.()
  pointerScope = undefined
}
/** Close the exemption of the input dispatch that just finished. */
function endWheelScope() {
  wheelScope?.()
  wheelScope = undefined
}
function endKeyScope() {
  keyScope?.()
  keyScope = undefined
}
function endPointerScopeOnBubble() {
  endPointerScope()
}
function handleScroll(event: Event) {
  const scroll = scrollRef.value
  if (scroll) {
    const previous = lastScrollTop ?? scroll.scrollTop
    lastScrollTop = scroll.scrollTop
    // Code moves this viewport too: bottom pinning, virtual-row height
    // compensation, navigation and the storage library's clamps. A recorded write
    // or an app-initiated scroll means the reader did not move it, so the
    // downward check below must not re-arm following on that account (TZD-135).
    const recordedWrite = consumeScrollWrite(scroll, scroll.scrollTop)
    // A navigation that has already moved the viewport is an animation that is
    // *running*: it keeps owning the movement it produces. One that never moved
    // anything was cancelled by the browser before its first frame and is only a
    // leftover mark — but it stays harmless until a touch gesture is actually
    // pending, because until then there is no reader to protect from it.
    const navigationMoved = appScrollHasMoved(scroll)
    const appNavigation = isAppScrolling(scroll, scroll.scrollTop)
    const gesturePending = touchCandidate || touchPointerId !== undefined
    const staleNavigation = appNavigation && !navigationMoved && gesturePending
    if (staleNavigation) finishAppScroll(scroll)
    const appOwned = recordedWrite || (appNavigation && !staleNavigation)
    // While an animation is running, its own movement re-bases the baselines so it
    // can never accumulate into a touch claim; app writes do the same.
    if (appOwned) {
      touchStartTop = scroll.scrollTop
      if (touchCandidate) touchCandidateTop = scroll.scrollTop
    }
    // A touch claims the viewport only once **this viewport** moved vertically, and
    // only for a scroll no app write accounts for: finger coordinates prove nothing,
    // and a streaming pin or a compensation write stays the app's even while a
    // finger rests on the conversation.
    //
    // A live press still yields to an app navigation in flight (an animation moves
    // the viewport under a resting finger), while a cancelled gesture
    // (`touchCandidate`) may override that mark: the browser ended the request, so
    // a stale mark must not block a real drag.
    //
    // A *live* press is corroborated by the finger: the reader drags the content,
    // so the viewport has to move opposite to the finger. Finger data is still
    // arriving there, and a purely sideways swipe has no vertical direction at all.
    //
    // A *cancelled* gesture has no such data: the platform stops delivering moves at
    // the cancel, so the direction seen before it describes an earlier movement —
    // a sideways pan's vertical jitter, or a drag the reader reversed after the
    // browser took over. It can never be evidence for the scrolls that follow
    // (TZD-135 review). What separates the two cases instead is the app mark:
    //
    // - a *running* animation (it already moved the viewport) keeps owning the
    //   movement it produces, so a cancelled gesture may not claim it;
    // - a mark that never moved anything is a leftover of a request the browser
    //   already cancelled. It is dropped above, which both frees this frame for the
    //   following check and lets the gesture claim movement in either direction.
    const candidateTravel = scroll.scrollTop - touchCandidateTop
    const pressTravel = scroll.scrollTop - touchStartTop
    const navigationOwns = appNavigation && !staleNavigation
    const claims =
      !touchScrolled &&
      !recordedWrite &&
      ((touchCandidate && !navigationOwns && Math.abs(candidateTravel) >= TOUCH_SCROLL_CLAIM_PX) ||
        (touchPointerId !== undefined &&
          !navigationOwns &&
          travelClaims(pressTravel, touchTravelDirection)))
    if (claims) claimTouchGesture(scroll)
    // Once claimed, the gesture owns the scrolls it causes (momentum included) and
    // it cancels any programmatic animation still pending (TZD-135 review).
    if (touchScrolled && appOwned) finishAppScroll(scroll)
    // The claim is decided *in this frame*, so this same frame must already judge
    // following by the post-claim ownership: a gesture whose first qualifying scroll
    // happens to land on the bottom has to restore following right away, while an
    // app-owned scroll keeps the decision as it was (TZD-135 review).
    const appOwnedNow = claims ? false : appOwned
    // Scroll events also cover scrollbar dragging and keyboard navigation, but
    // layout shrinkage clamps scrollTop to the new bottom without user intent.
    if (shouldReleaseBottomLockOnScroll(previous, scroll.scrollTop, scroll.scrollHeight - scroll.clientHeight))
      releaseBottomLock()
    else if (!appOwnedNow && shouldResumeBottomLock(
      previous,
      scroll.scrollTop,
      scroll.scrollHeight - scroll.clientHeight,
      readingHistory,
    )) readingHistory = false
  }
  emit('scroll', event)
}
// With resize="instant", pin scrollTop synchronously in the ResizeObserver
// callback (after layout, before paint). The library defers its correction to
// the next animation frame, which paints one frame per streaming chunk with a
// stale scrollTop and makes the scrollbar bounce.
watchEffect((onCleanup) => {
  const scroll = scrollRef.value
  const content = contentRef.value
  if (!scroll || !content || props.resize !== 'instant') return
  // A viewport resize can make the library escape after a layout clamp as well.
  // Follow our reading intent, rather than that incidental library state.
  const pin = () => pinToBottom(scroll, !readingHistory, false)
  const observer = new ResizeObserver(pin)
  observer.observe(content)
  observer.observe(scroll)
  onCleanup(() => observer.disconnect())
})
provide(conversationKey, { ...context, scrollToBottom, stopScroll: releaseBottomLock })
let stopObservingWrites: (() => void) | undefined
watchEffect((onCleanup) => {
  const scroll = scrollRef.value
  if (!scroll) return
  stopObservingWrites = observeScrollWrites(scroll)
  onCleanup(() => {
    stopObservingWrites?.()
    stopObservingWrites = undefined
  })
})
onMounted(() => {
  // Capture opens an exemption, bubble closes it; the closer is also armed with a
  // microtask so a listener that stops propagation cannot leak it.
  window.addEventListener('wheel', handleWheelCapture, { capture: true, passive: true })
  window.addEventListener('wheel', endWheelScope)
  window.addEventListener('keydown', handleKeyDownCapture, true)
  window.addEventListener('keydown', endKeyScope)
  window.addEventListener('pointerdown', handlePointerCapture, true)
  window.addEventListener('pointerdown', endPointerScopeOnBubble)
  window.addEventListener('pointermove', handlePointerCapture, true)
  window.addEventListener('pointermove', endPointerScopeOnBubble)
  window.addEventListener('pointerup', handlePointerRelease, true)
  window.addEventListener('pointercancel', handlePointerRelease, true)
  if (props.initial === 'instant' && scrollRef.value)
    scrollRef.value.scrollTop = scrollRef.value.scrollHeight
  lastScrollTop = scrollRef.value?.scrollTop
})
/**
 * `scrollend` is the browser's own confirmation that an app-initiated scroll
 * finished. It fires on the scrolling element, so it is attached to the viewport
 * and ends the attribution even when the requested position was never reached
 * (e.g. a `scrollIntoView` without a known target, or an interrupted animation).
 */
watchEffect((onCleanup) => {
  const scroll = scrollRef.value
  if (!scroll) return
  const onEnd = (event: Event) => {
    if (event.target !== scroll) return
    finishAppScroll(scroll)
  }
  scroll.addEventListener('scrollend', onEnd)
  onCleanup(() => scroll.removeEventListener('scrollend', onEnd))
})
onBeforeUnmount(() => {
  window.removeEventListener('wheel', handleWheelCapture, { capture: true })
  window.removeEventListener('wheel', endWheelScope)
  window.removeEventListener('keydown', handleKeyDownCapture, true)
  window.removeEventListener('keydown', endKeyScope)
  window.removeEventListener('pointerdown', handlePointerCapture, true)
  window.removeEventListener('pointerdown', endPointerScopeOnBubble)
  window.removeEventListener('pointermove', handlePointerCapture, true)
  window.removeEventListener('pointermove', endPointerScopeOnBubble)
  window.removeEventListener('pointerup', handlePointerRelease, true)
  window.removeEventListener('pointercancel', handlePointerRelease, true)
})
</script>

<template>
  <ScrollAreaRoot :class="cn('relative min-h-0 min-w-0 flex-1 overflow-hidden', props.class)">
    <ScrollAreaViewport ref="viewport" class="size-full [&>div]:!block [&>div]:min-h-full [&>div]:min-w-0"
      :style="{ overflowAnchor: props.anchor }" @scroll="handleScroll" role="log" :aria-label="props.ariaLabel" tabindex="0">
      <div :ref="el => { contentRef = el as HTMLElement | null }"><slot /></div>
    </ScrollAreaViewport>
    <ScrollBar />
    <slot name="overlay" />
  </ScrollAreaRoot>
</template>
