<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
import { reactiveOmit } from '@vueuse/core'
import { useStickToBottom } from 'vue-stick-to-bottom'
import { nextTick, onBeforeUnmount, onMounted, provide, ref, watch, watchEffect } from 'vue'
import { ScrollAreaRoot, ScrollAreaViewport } from 'reka-ui'
import { ScrollBar } from '@/components/ui/scroll-area'
import { pinToBottom } from '@/lib/bottomPin'
import { canScrollConversation, keyScrollsConversation, shouldReleaseBottomLockOnScroll, shouldResumeBottomLock } from '@/lib/scrollIntent'
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
  touchMoved = false
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
 * A touch gesture that actually scrolled the content.
 *
 * A press alone is not scrolling: the browser only takes the touch over once the
 * finger moves, and it signals that with `pointercancel` (after which no further
 * `pointermove` arrives, and the first `scroll` may come later or after momentum).
 * So the takeover is armed by the movement itself — `pointercancel`, or a
 * `pointermove` past the threshold on platforms that keep delivering moves — and
 * deliberately survives `pointerup`/`pointercancel`, because the scrolls those
 * gestures cause arrive afterwards (TZD-135 review).
 */
let touchMoved = false
let touchOrigin: { x: number; y: number } | undefined
/** Distance, in px, a touch must travel before it counts as scrolling content. */
const TOUCH_MOVE_THRESHOLD_PX = 3
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
  if (event.pointerType === "touch") {
    if (event.type === "pointerdown" && scroll.contains(event.target)) {
      // A press alone is not scrolling: remember where it started and wait for
      // the gesture to become one before claiming anything from the app.
      touchOrigin = { x: event.clientX, y: event.clientY }
      touchMoved = false
    } else if (event.type === "pointermove" && touchOrigin && !touchMoved) {
      const dx = Math.abs(event.clientX - touchOrigin.x)
      const dy = Math.abs(event.clientY - touchOrigin.y)
      if (Math.max(dx, dy) >= TOUCH_MOVE_THRESHOLD_PX) claimTouchGesture(scroll)
    }
  }
  if (event.type !== "pointerdown" && event.type !== "pointermove") return
  if (!ownScrollbar(event.target)) return
  pointerScope = beginUserInput(scroll)
  if (event.type === "pointerdown") finishAppScroll(scroll)
}
/**
 * The touch became a content scroll, so it cancels any programmatic animation and
 * owns the scrolls that follow it.
 */
function claimTouchGesture(scroll: HTMLElement) {
  touchMoved = true
  finishAppScroll(scroll)
}
function handlePointerRelease(event: PointerEvent) {
  const scroll = scrollRef.value
  if (event.pointerType === "touch") {
    // `pointercancel` is the browser taking the touch over for scrolling (it stops
    // delivering moves at that point); a plain `pointerup` means the finger
    // lifted without scrolling the content.
    if (event.type === "pointercancel" && scroll) claimTouchGesture(scroll)
    touchOrigin = undefined
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
    // A native touch gesture that moved is the reader: it cancels any programmatic
    // animation, so its scroll events belong to the gesture even when an app mark
    // was still pending (TZD-135 review).
    if (touchMoved) finishAppScroll(scroll)
    // Code moves this viewport too: bottom pinning, virtual-row height
    // compensation, navigation and the storage library's clamps. A recorded write
    // or an app-initiated scroll means the reader did not move it, so the
    // downward check below must not re-arm following on that account (TZD-135).
    const appOwned = consumeScrollWrite(scroll, scroll.scrollTop) || isAppScrolling(scroll, scroll.scrollTop)
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
