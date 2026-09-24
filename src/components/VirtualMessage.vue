<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { conversationKey } from '@/components/ai-elements/conversation/context'

const props = withDefaults(defineProps<{
  enabled: boolean
  pinned?: boolean
  live?: boolean
}>(), { pinned: false, live: false })
const context = inject(conversationKey)
const shell = ref<HTMLElement>()
const body = ref<HTMLElement>()
const nearby = ref(false)
const revealed = ref(false)
const focused = ref(false)
const height = ref(160)
const rendered = computed(() => !props.enabled || props.pinned || props.live || nearby.value || revealed.value || focused.value)
// Keep the animation policy stable for one mounted lifetime, including completion.
const animate = ref(props.live)
let intersection: IntersectionObserver | undefined
let resize: ResizeObserver | undefined
let disposed = false

function measure() {
  const el = body.value
  if (!el) return
  const next = el.getBoundingClientRect().height
  if (!next) return
  const previous = height.value
  height.value = next
  const viewport = context?.scrollRef.value
  if (!viewport || !shell.value) return
  // Correct estimates above the reading position; leave bottom-follow to Conversation.
  const above = shell.value.getBoundingClientRect().top + previous <= viewport.getBoundingClientRect().top
  const atBottom = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 32
  if (above && !atBottom) viewport.scrollTop += next - previous
}
function reveal() { revealed.value = true }
async function focusOut() {
  await nextTick()
  focused.value = !!shell.value?.contains(document.activeElement)
}
watch(() => props.live, live => { if (live) animate.value = true })
watch(rendered, async visible => {
  resize?.disconnect()
  if (!visible) return
  animate.value = props.live
  await nextTick()
  if (disposed) return
  if (body.value) resize?.observe(body.value)
  measure()
}, { flush: 'post' })
onMounted(() => {
  resize = new ResizeObserver(measure)
  if (body.value) { resize.observe(body.value); measure() }
  watch(() => context?.scrollRef.value, viewport => {
    intersection?.disconnect()
    if (!viewport || !shell.value) return
    intersection = new IntersectionObserver(entries => {
      for (const entry of entries) {
        // Preserve an active text selection rather than removing it under the user.
        const selection = window.getSelection()
        const selecting = selection && !selection.isCollapsed &&
          (shell.value?.contains(selection.anchorNode) || shell.value?.contains(selection.focusNode))
        if (!entry.isIntersecting && selecting) continue
        nearby.value = entry.isIntersecting
        if (entry.isIntersecting) revealed.value = false
      }
    }, { root: viewport, rootMargin: '800px 0px' })
    intersection.observe(shell.value)
  }, { immediate: true, flush: 'post' })
})
onBeforeUnmount(() => { disposed = true; intersection?.disconnect(); resize?.disconnect() })
</script>

<template>
  <!-- Retain a cheap, addressable shell so timeline navigation can reveal an unmounted row. -->
  <div ref="shell" class="min-w-0 shrink-0" :style="rendered ? undefined : { height: `${height}px` }"
    :data-virtual-mounted="rendered" @virtual-reveal="reveal" @focusin="focused = true" @focusout="focusOut">
    <div v-if="rendered" ref="body" class="flow-root min-w-0">
      <slot :animate="animate" />
    </div>
  </div>
</template>
