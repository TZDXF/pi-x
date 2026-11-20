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
  // A new navigation replaces any earlier gesture's claim.
  touchScrolled = false
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
 * A gesture is only the reader's once it actually moved this viewport: pointer
 * coordinates prove nothing (a sideways swipe, a three-pixel wobble, or a pan
 * inside a nested scroller all move the finger without moving the conversation).
 *
 * So the claim rests on the viewport's own movement:
 *
 * - a scroll event while the tracked pointer is down, further than
 *   `TOUCH_SCROLL_CLAIM_PX` from the position it started at, and not itself an
 *   app-initiated scroll — that is the gesture scrolling the conversation;
 * - the browser's `pointercancel` for **that** pointer, which is how it signals
 *   that it took the touch over (it stops delivering moves then, and the scrolls
 *   that follow are the gesture's). This is also the only signal on platforms
 *   whose cancellation never reaches the viewport.
 *
 * `touchScrollsConversation` keeps nested scrollers out of both paths, and
 * `pointerId` binds a cancellation to the gesture being tracked, so a cancel from
 * another pointer (or another pane) cannot end the app's navigation.
 */
let touchPointerId: number | undefined
/** Viewport position when the tracked touch started. */
let touchStartTop = 0
/** Largest vertical finger travel reported for the tracked pointer. */
let touchTravelY = 0
/** The tracked gesture has been attributed to the reader. */
let touchScrolled = false
/** Viewport travel a touch must cause before it counts as scrolling. */
const TOUCH_SCROLL_CLAIM_PX = 4
/**
 * Finger travel needed to accept a `pointercancel` that arrives before the first
 * scroll event: that is how platforms whose cancellation hides the scrolls
 * deliver a genuine drag. A wobble or a sideways swipe stays well below it.
 */
const TOUCH_DRAG_CLAIM_PX = 10
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
    touchScrolled = false
    touchTravelY = 0
  } else if (event.type === "pointermove" && event.pointerType === "touch" && event.pointerId === touchPointerId) {
    // Remember how far the tracked finger travelled; a cancellation that arrives
    // before the first scroll is accepted on this, never on cancel coordinates.
    touchTravelY = Math.max(touchTravelY, Math.abs(event.movementY || 0))
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
  finishAppScroll(scroll)
}
function handlePointerRelease(event: PointerEvent) {
  const scroll = scrollRef.value
  if (event.pointerType === "touch" && event.pointerId === touchPointerId) {
    // `pointercancel` for the tracked pointer is the browser taking the touch over
    // for scrolling (it stops delivering moves then); a plain `pointerup` means
    // the finger lifted. The cancellation itself is only accepted when the tracked
    // finger actually travelled vertically, because a sideways swipe or a wobble
    // cancels too — and its coordinates, which the platform may zero out, are
    // never evidence (TZD-135 review).
    if (event.type === "pointercancel" && scroll && touchTravelY >= TOUCH_DRAG_CLAIM_PX) claimTouchGesture(scroll)
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
    const appOwned = consumeScrollWrite(scroll, scroll.scrollTop) || isAppScrolling(scroll, scroll.scrollTop)
    // A tracked touch only claims the viewport once it moved it *itself*: a still
    // pending app animation also moves the viewport while a finger rests on it, and
    // finger coordinates prove nothing either (sideways swipes, tiny wobbles and
    // pans inside a nested scroller all leave the conversation where it was).
    if (
      touchPointerId !== undefined &&
      !touchScrolled &&
      !appOwned &&
      Math.abs(scroll.scrollTop - touchStartTop) >= TOUCH_SCROLL_CLAIM_PX
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
