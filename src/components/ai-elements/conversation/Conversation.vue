<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
import { reactiveOmit } from '@vueuse/core'
import { useStickToBottom } from 'vue-stick-to-bottom'
import { nextTick, onBeforeUnmount, onMounted, provide, ref, watch, watchEffect } from 'vue'
import { ScrollAreaRoot, ScrollAreaViewport } from 'reka-ui'
import { ScrollBar } from '@/components/ui/scroll-area'
import { pinToBottom } from '@/lib/bottomPin'
import { shouldReleaseBottomLock, shouldReleaseBottomLockOnScroll, shouldResumeBottomLock, targetsConversationViewport } from '@/lib/scrollIntent'
import { beginAppScroll, beginUserInput, consumeScrollWrite, endUserInput, isAppScrolling, observeScrollWrites } from '@/lib/scrollWrites'
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
  scrollToMessage: async (id: number) => {
    const viewport = scrollRef.value
    const message = viewport?.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
    if (!viewport || !message) return
    releaseBottomLock()
    message.dispatchEvent(new Event('virtual-reveal'))
    await nextTick()
    if (!message.isConnected) return
    // Navigation is the app's movement, not the reader's: mark the viewport so
    // the settling events (including one clamped onto the bottom) cannot re-arm
    // following (TZD-135).
    beginAppScroll(viewport)
    viewport.scrollTo({
      top: viewport.scrollTop + message.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 24,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    })
  },
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
/** Keys that scroll the conversation; their movement is the reader's. */
const CONVERSATION_SCROLL_KEYS = new Set(['End', 'Home', 'PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', ' '])
function releaseBottomLock() {
  readingHistory = true
  context.stopScroll()
}
function scrollToBottom(options?: Parameters<typeof context.scrollToBottom>[0]) {
  readingHistory = false
  return context.scrollToBottom(options)
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
function handleWheel(event: WheelEvent) {
  const scroll = scrollRef.value
  if (!scroll || event.ctrlKey || event.defaultPrevented || !(event.target instanceof Element)) return
  // The reader's own gesture outranks any recorded write, so the movement it
  // produces can never be mistaken for one the app made.
  beginUserInput(scroll)
  // Reka uses overflow: hidden scroll, which the library's shorthand overflow
  // check misses. Release before virtual row resizing can pin us back down.
  if (shouldReleaseBottomLock(scroll, event.target, event.deltaY)) releaseBottomLock()
}
function handleKeyDown(event: KeyboardEvent) {
  const scroll = scrollRef.value
  if (!scroll || event.defaultPrevented) return
  if (CONVERSATION_SCROLL_KEYS.has(event.key)) beginUserInput(scroll)
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
    const userOwned = !consumeScrollWrite(scroll, scroll.scrollTop) && !isAppScrolling(scroll)
    // Scroll events also cover scrollbar dragging and keyboard navigation, but
    // layout shrinkage clamps scrollTop to the new bottom without user intent.
    if (shouldReleaseBottomLockOnScroll(previous, scroll.scrollTop, scroll.scrollHeight - scroll.clientHeight))
      releaseBottomLock()
    else if (userOwned && shouldResumeBottomLock(
      previous,
      scroll.scrollTop,
      scroll.scrollHeight - scroll.clientHeight,
      readingHistory,
    )) readingHistory = false
  }
  emit('scroll', event)
}
// Scrollbar interaction is the reader, not the app: Reka positions the thumb by
// assigning scrollTop on every pointer move. Only the conversation's own
// scrollbar counts — a nested or unrelated one does not make this viewport's
// writes the reader's.
let draggingScrollbar = false
function ownScrollbar(target: Element): Element | null {
  const scroll = scrollRef.value
  if (!scroll) return null
  const scrollbar = target.closest('[data-slot="scroll-area-scrollbar"]')
  // Only this conversation's scrollbar: its parent is the same ScrollAreaRoot.
  return scrollbar && scrollbar.parentElement === scroll.parentElement ? scrollbar : null
}
function handlePointerDown(event: PointerEvent) {
  const scroll = scrollRef.value
  if (!scroll || !(event.target instanceof Element)) return
  const scrollbar = ownScrollbar(event.target)
  if (!scrollbar) return
  draggingScrollbar = true
  beginUserInput(scroll)
}
function handlePointerMove() {
  const scroll = scrollRef.value
  // Each move is its own dispatch: refresh the reader's window so the thumb's
  // scrollTop writes stay the reader's. Merely holding the thumb still opens
  // none, which is what keeps later compensation writes app-owned.
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
  // Reka handles a wheel over the scrollbar track with a document-level listener
  // (it writes viewport.scrollTop), so the viewport's own handler never runs. A
  // wheel over the conversation's scrollbar is still the reader's gesture.
  if (!targetsConversationViewport(scroll, event.target) || scroll.contains(event.target)) return
  beginUserInput(scroll)
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
