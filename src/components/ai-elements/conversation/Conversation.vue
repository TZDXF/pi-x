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
import {
  beginAppScroll,
  beginUserInput,
  consumeScrollWrite,
  endUserInput,
  finishAppScroll,
  isAppScrolling,
  observeScrollWrites,
  recordScrollWrite,
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
  beginAppScroll(scroll, targetTop)
  scroll.scrollTo({ top: requested, behavior: instant ? 'instant' : 'smooth' })
  if (instant) {
    // An instant scroll has already happened by the time it returns, so the
    // browser's arrival event is pending: finish the attribution now and record
    // the settled position so that event is still recognized as the app's.
    finishAppScroll(scroll)
    recordScrollWrite(scroll, scroll.scrollTop)
  }
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
/** The reader is driving this viewport: any pending app attribution ends here. */
function takeOverViewport(scroll: HTMLElement) {
  beginUserInput(scroll)
  finishAppScroll(scroll)
}
function handleWheel(event: WheelEvent) {
  const scroll = scrollRef.value
  if (!scroll || event.ctrlKey || event.defaultPrevented || !(event.target instanceof Element)) return
  // Reka uses overflow: hidden scroll, which the library's shorthand overflow
  // check misses. Release before virtual row resizing can pin us back down.
  if (!canScrollConversation(scroll, event.target, event.deltaY)) return
  takeOverViewport(scroll)
  if (event.deltaY < 0) releaseBottomLock()
}
function handleKeyDown(event: KeyboardEvent) {
  const scroll = scrollRef.value
  // Space activates a focused control instead of scrolling; treating it as input
  // used to launder the layout write that follows the keystroke (TZD-135 review).
  if (!scroll || !keyScrollsConversation(scroll, event)) return
  takeOverViewport(scroll)
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
/**
 * Reka positions the scrollbar thumb by assigning `scrollTop` on pointer moves, and
 * listens for `wheel` on the document, so neither reaches the viewport's own
 * handlers. Both are still the reader's input. Only this conversation's scrollbar
 * counts: its parent is the same ScrollAreaRoot, so a nested or unrelated
 * scrollbar cannot claim the reader for this viewport.
 */
function ownScrollbar(target: Element): boolean {
  const scroll = scrollRef.value
  if (!scroll) return false
  const scrollbar = target.closest('[data-slot="scroll-area-scrollbar"]')
  return !!scrollbar && scrollbar.parentElement === scroll.parentElement
}
let draggingScrollbar = false
function handlePointerDown(event: PointerEvent) {
  const scroll = scrollRef.value
  if (!scroll || !(event.target instanceof Element) || !ownScrollbar(event.target)) return
  draggingScrollbar = true
  takeOverViewport(scroll)
}
function handlePointerMove() {
  const scroll = scrollRef.value
  // Each move is its own dispatch, so each re-opens the exemption for the thumb's
  // write. Holding the thumb still opens none, which keeps later compensation
  // writes app-owned.
  if (draggingScrollbar && scroll) beginUserInput(scroll)
}
function handlePointerUp() {
  const scroll = scrollRef.value
  draggingScrollbar = false
  if (scroll) endUserInput(scroll)
}
function handleCanvasWheel(event: WheelEvent) {
  const scroll = scrollRef.value
  if (!scroll || event.ctrlKey || event.defaultPrevented || !(event.target instanceof Element)) return
  if (scroll.contains(event.target) || !ownScrollbar(event.target)) return
  takeOverViewport(scroll)
  if (event.deltaY < 0 && scroll.scrollHeight > scroll.clientHeight) releaseBottomLock()
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
  window.addEventListener('pointerdown', handlePointerDown, true)
  window.addEventListener('pointermove', handlePointerMove, true)
  window.addEventListener('pointerup', handlePointerUp, true)
  window.addEventListener('pointercancel', handlePointerUp, true)
  // Capture on the document so a wheel over the conversation's own scrollbar
  // (a sibling of the viewport) is attributed to the reader as well.
  window.addEventListener('wheel', handleCanvasWheel, { capture: true, passive: true })
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
  window.removeEventListener('pointerdown', handlePointerDown, true)
  window.removeEventListener('pointermove', handlePointerMove, true)
  window.removeEventListener('pointerup', handlePointerUp, true)
  window.removeEventListener('pointercancel', handlePointerUp, true)
  window.removeEventListener('wheel', handleCanvasWheel, { capture: true })
})
</script>

<template>
  <ScrollAreaRoot :class="cn('relative min-h-0 min-w-0 flex-1 overflow-hidden', props.class)">
    <ScrollAreaViewport ref="viewport" class="size-full [&>div]:!block [&>div]:min-h-full [&>div]:min-w-0"
      :style="{ overflowAnchor: props.anchor }" @scroll="handleScroll" @wheel.passive="handleWheel" @keydown="handleKeyDown" role="log" :aria-label="props.ariaLabel" tabindex="0">
      <div :ref="el => { contentRef = el as HTMLElement | null }"><slot /></div>
    </ScrollAreaViewport>
    <ScrollBar />
    <slot name="overlay" />
  </ScrollAreaRoot>
</template>
