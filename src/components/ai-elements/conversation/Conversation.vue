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
} from '@/lib/scrollIntent'
import type { InputScopeCloser } from '@/lib/scrollWrites'
import {
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
/** The tracked gesture has been attributed to the reader. */
let touchScrolled = false
/** Viewport travel a touch must cause before it counts as scrolling. */
const TOUCH_SCROLL_CLAIM_PX = 4
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
    const appNavigation = isAppScrolling(scroll, scroll.scrollTop)
    const appOwned = recordedWrite || appNavigation
    // A touch claims the viewport only once **this viewport** moved vertically, and
    // only for a scroll no app write accounts for: finger coordinates prove nothing,
    // and a streaming pin or a compensation write stays the app's even while a
    // finger rests on the conversation.
    //
    // A live press still yields to an app navigation in flight (an animation moves
    // the viewport under a resting finger). A cancelled gesture
    // (`touchCandidate`) may override that mark: the browser already cancelled the
    // animation, so its scrolls are the gesture's, and a stale mark must not block
    // a real drag (TZD-135 review).
    // A cancelled gesture is confirmed by the movement the browser produced *after*
    // the cancel: whatever an app animation did before it is not the gesture's,
    // and a stale mark must not block a real drag (TZD-135 review).
    const candidateTravel = Math.abs(scroll.scrollTop - touchCandidateTop)
    const pressTravel = Math.abs(scroll.scrollTop - touchStartTop)
    if (
      !touchScrolled &&
      !recordedWrite &&
      ((touchCandidate && candidateTravel >= TOUCH_SCROLL_CLAIM_PX) ||
        (touchPointerId !== undefined && !appNavigation && pressTravel >= TOUCH_SCROLL_CLAIM_PX))
    )
      claimTouchGesture(scroll)
    // Once claimed, the gesture owns the scrolls it causes (momentum included) and
    // it cancels any programmatic animation still pending (TZD-135 review).
    if (touchScrolled) finishAppScroll(scroll)
    // Scroll events also cover scrollbar dragging and keyboard navigation, but
    // layout shrinkage clamps scrollTop to the new bottom without user intent.
    if (shouldReleaseBottomLockOnScroll(previous, scroll.scrollTop, scroll.scrollHeight - scroll.clientHeight))
      releaseBottomLock()
    else if (!appOwned && shouldResumeBottomLock(
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
