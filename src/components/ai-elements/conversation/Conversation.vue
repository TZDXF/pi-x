<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'
import { reactiveOmit } from '@vueuse/core'
import { useStickToBottom } from 'vue-stick-to-bottom'
import { nextTick, onBeforeUnmount, onMounted, provide, ref, watch, watchEffect } from 'vue'
import { ScrollAreaRoot, ScrollAreaViewport } from 'reka-ui'
import { ScrollBar } from '@/components/ui/scroll-area'
import { pinToBottom } from '@/lib/bottomPin'
import { beginReveal, nextFrame, revealElement, type RevealRequest } from '@/lib/revealScroll'
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
/**
 * 定位过程中的抑制计数（TZD-138 P2）：`VirtualMessage` 的行高补偿会直接写 `scrollTop`，
 * 一次写入就会打断平滑滚动。定位期间把计数抬起来，让行高照常量、不写滚动位置；
 * 定位流程自己按最新布局反复校正，直到目标真的进入视口。
 */
const revealLock = ref(0)
/**
 * 是否真有**用户发起的定位**正在接管滚动（不含"阅读锚定"自己占用的锁）。
 * 两者分开：锚定流程也在 `revealLock` 里（要抑制行高补偿），但它自己必须能继续工作。
 */
const locating = ref(0)
/**
 * 在**发起定位的那一刻**为该视口取得请求身份（TZD-138 P2 跨入口竞态）。
 * 重挂虚拟行、展开折叠正文、重算锚点都是 `await`：如果等到真正滚动时才领身份，
 * "先发起、后恢复"的旧请求会被当成最新，把用户后来点的目标顶掉（QA 三内核复现）。
 */
function beginRequest(): { viewport: HTMLElement; request: RevealRequest } | null {
  const viewport = scrollRef.value
  if (!viewport) return null
  return { viewport, request: beginReveal(viewport) }
}
/** 定位期间抑制行高补偿的写入（`VirtualMessage` 通过 context 读这个计数）。 */
async function withRevealLock<T>(run: () => Promise<T>): Promise<T> {
  revealLock.value++
  try {
    return await run()
  } finally {
    revealLock.value--
  }
}
/**
 * 把一个元素滚进视口并验证结果（返回是否到位）：沿用调用方给的请求身份（没有则在此取得），
 * 期间禁止行高补偿写 `scrollTop`。
 */
async function revealInViewport(
  target: Element | null | undefined,
  options: { animated?: boolean; request?: RevealRequest } = {},
) {
  const element = target
  if (!element || !(element instanceof HTMLElement)) return false
  const started = options.request ? { viewport: scrollRef.value, request: options.request } : beginRequest()
  if (!started?.viewport) return false
  // 已被更新的定位顶替：直接终止，不再动滚动位置。
  if (!started.request.isCurrent()) return false
  // 定位是"去读历史"的意图：释放底部跟随，否则内容变动会把人拉回底部。
  releaseBottomLock()
  locating.value++
  try {
    return await withRevealLock(() =>
      revealElement(started.viewport as HTMLElement, element, { animated: options.animated, request: started.request }),
    )
  } finally {
    locating.value--
  }
}
defineExpose({
  stopScroll: releaseBottomLock,
  scrollToBottom,
  /** 通用入口：把任意视口内元素滚到视口里（划词引用徽标就用它）。 */
  revealInViewport,
  /** 在**发起定位的那一刻**取得该视口的请求身份（跨入口竞态的根修复点）。 */
  beginRevealRequest: (): RevealRequest | null => beginRequest()?.request ?? null,
  /** 在一段"自己写 `scrollTop`"的流程里抑制虚拟行的行高补偿（历史前插锚定）。 */
  withAnchorLock: withRevealLock,
  /** 当前是否有定位正在接管滚动（此时外部的滚动补偿应让位）。 */
  isRevealActive: () => locating.value > 0,
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
 * confirmed finished (TZD-135), and **verify** the target really reached the
 * requested position (TZD-138): virtual rows remount with estimated heights that
 * get replaced one after another, so a single write can stop short (QA 三内核
 * 实测目标留在视口外）。`revealElement` 负责"滚 → 等停 → 复核 → 修正"，
 * 并贯穿调用方发起定位时取得的请求身份（被更新定位顶替后立刻终止）。
 */
async function scrollToMessage(id: number, inherited?: RevealRequest) {
  const scroll = scrollRef.value
  const message = scroll?.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
  if (!scroll || !message) return false
  // **进入即领取身份**（在任何 await 之前）：重挂要等一帧，期间可能已有更新的定位。
  // 引用定位会把**自己发起时**取得的身份传进来：它不能在这里重新领，否则会反过来
  // 顶掉用户更晚发起的那次定位。
  const started = inherited ? { viewport: scroll, request: inherited } : beginRequest()
  if (!started?.viewport) return false
  const { viewport, request } = started as { viewport: HTMLElement; request: RevealRequest }
  // 作废后立刻终止，不改走别的回退（否则旧请求会重新取得滚动权）。
  if (!request.isCurrent()) return false
  releaseBottomLock()
  // A new navigation replaces any earlier gesture's claim and candidate (TZD-135).
  touchScrolled = false
  touchCandidate = false
  touchPointerId = undefined
  locating.value++
  try {
    return await withRevealLock(async () => {
      // 虚拟行可能整行卸载，`virtual-reveal` 让它重挂；等一帧布局稳定再量位置。
      message.dispatchEvent(new Event('virtual-reveal'))
      await nextTick()
      await nextFrame()
      if (!request.isCurrent() || !message.isConnected) return false
      // The requested position is handed over as the confirmation target: the arrival
      // at that position ends the attribution (TZD-135). Later correction writes keep
      // the mark, so a resting finger cannot claim this movement.
      const requested =
        viewport.scrollTop + message.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 24
      const max = viewport.scrollHeight - viewport.clientHeight
      beginAppScroll(viewport, Math.max(0, Math.min(requested, max)), viewport.scrollTop)
      // 与原有行为一致：目标顶端贴视口顶端（留 24px），长消息也能从开头读起。
      const landed = await revealElement(viewport, message, {
        animated: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        align: 'start',
        margin: 24,
        request,
      })
      finishAppScroll(viewport)
      return landed
    })
  } finally {
    locating.value--
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
provide(conversationKey, { ...context, scrollToBottom, stopScroll: releaseBottomLock, revealLock })
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
