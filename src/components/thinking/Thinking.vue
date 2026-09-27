<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { Collapsible } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { useVModel } from "@vueuse/core"
import { computed, onBeforeUnmount, provide, ref, watch } from "vue"
import { ThinkingKey } from "./context"

interface Props {
  class?: HTMLAttributes["class"]
  isStreaming?: boolean
  open?: boolean
  defaultOpen?: boolean
  duration?: number
}

const props = withDefaults(defineProps<Props>(), {
  isStreaming: false,
  defaultOpen: false,
  duration: undefined,
})

const emit = defineEmits<{
  (e: "update:open", value: boolean): void
}>()

const isOpen = useVModel(props, "open", emit, {
  defaultValue: props.defaultOpen,
  passive: true,
})

const MS_IN_S = 1000
const AUTO_CLOSE_DELAY = 1000
// 收起动画需要真实内容高度,收起后延迟卸载重 DOM。
const CONTENT_COLLAPSE_UNMOUNT_DELAY = 300

const duration = ref<number | undefined>(props.duration)
const startTime = ref<number | null>(null)

watch(() => props.duration, (val) => {
  duration.value = val
})

// 用户手动开合后,自动规则(流结束自动收起)永久退出,不能覆盖用户选择。
const userInteracted = ref(false)

function setIsOpen(val: boolean) {
  userInteracted.value = true
  isOpen.value = val
}

// 收起动画期间内容仍需挂载;动画跑完再真正卸载。
const shouldRenderContent = ref(isOpen.value)
let unmountTimer: number | null = null

watch(isOpen, (open) => {
  if (open) {
    if (unmountTimer !== null) {
      window.clearTimeout(unmountTimer)
      unmountTimer = null
    }
    shouldRenderContent.value = true
    return
  }
  if (!shouldRenderContent.value)
    return
  unmountTimer = window.setTimeout(() => {
    shouldRenderContent.value = false
    unmountTimer = null
  }, CONTENT_COLLAPSE_UNMOUNT_DELAY)
})

// 流结束边界自动收起(仅一次;用户操作过则跳过)。
let autoCloseTimer: number | null = null

function clearAutoCloseTimer() {
  if (autoCloseTimer !== null) {
    window.clearTimeout(autoCloseTimer)
    autoCloseTimer = null
  }
}

watch(() => props.isStreaming, (streaming, prev) => {
  if (streaming) {
    if (startTime.value === null && props.duration === undefined)
      startTime.value = Date.now()
    return
  }
  if (startTime.value !== null) {
    duration.value = Math.max(1, Math.ceil((Date.now() - startTime.value) / MS_IN_S))
    startTime.value = null
  }
  if (prev === true && !userInteracted.value && isOpen.value) {
    clearAutoCloseTimer()
    autoCloseTimer = window.setTimeout(() => {
      autoCloseTimer = null
      if (!userInteracted.value)
        isOpen.value = false
    }, AUTO_CLOSE_DELAY)
  }
}, { immediate: true })

// 实时秒数只在展开态计时;收起态不为隐藏的数字每秒重渲染,
// 流结束耗时由 startTime 一次性补算。
let liveTimer: number | null = null

watch([() => props.isStreaming, isOpen], ([streaming, open]) => {
  const shouldTick = streaming && open && startTime.value !== null
  if (shouldTick && liveTimer === null) {
    duration.value = Math.max(1, Math.ceil((Date.now() - startTime.value!) / MS_IN_S))
    liveTimer = window.setInterval(() => {
      if (startTime.value === null)
        return
      duration.value = Math.max(1, Math.ceil((Date.now() - startTime.value) / MS_IN_S))
    }, MS_IN_S)
  }
  else if (!shouldTick && liveTimer !== null) {
    window.clearInterval(liveTimer)
    liveTimer = null
  }
}, { immediate: true })

onBeforeUnmount(() => {
  clearAutoCloseTimer()
  if (liveTimer !== null)
    window.clearInterval(liveTimer)
  if (unmountTimer !== null)
    window.clearTimeout(unmountTimer)
})

provide(ThinkingKey, {
  isStreaming: computed(() => props.isStreaming),
  isOpen,
  shouldRenderContent,
  setIsOpen,
  duration,
})
</script>

<template>
  <Collapsible
    v-model:open="isOpen"
    :class="cn('not-prose w-full', props.class)"
  >
    <slot />
  </Collapsible>
</template>
