<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { CollapsibleContent } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue"
import { useThinkingContext } from "./context"
import {
  EMPTY_SCROLL_MASK_STATE,
  getVerticalScrollMaskStyle,
  resolveVerticalScrollMaskState,
  type ScrollMaskState,
} from "./scrollMask"

interface Props {
  class?: HTMLAttributes["class"]
  content?: string
}

const props = withDefaults(defineProps<Props>(), { content: "" })

const { isOpen, shouldRenderContent } = useThinkingContext()

// 思考内容按纯文本展示(whitespace-pre-wrap):展开后流式追加若走 Markdown,
// 每个 chunk 都会重跑解析与插件渲染,字数越多越卡。
const shouldRender = computed(() => isOpen.value || shouldRenderContent.value)

const scrollRef = ref<HTMLElement | null>(null)
const contentRef = ref<HTMLElement | null>(null)
const autoFollowBottom = ref(true)
const scrollMaskState = ref<ScrollMaskState>(EMPTY_SCROLL_MASK_STATE)

const BOTTOM_LOCK_DISTANCE_PX = 2

const scrollMaskStyle = computed(() => getVerticalScrollMaskStyle(scrollMaskState.value))

function updateScrollMaskState() {
  const node = scrollRef.value
  if (!node) {
    scrollMaskState.value = EMPTY_SCROLL_MASK_STATE
    return
  }
  scrollMaskState.value = resolveVerticalScrollMaskState({
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
    scrollTop: node.scrollTop,
  })
}

function scrollToBottom() {
  const node = scrollRef.value
  if (!node)
    return
  node.scrollTop = node.scrollHeight
  updateScrollMaskState()
}

function onScroll() {
  const node = scrollRef.value
  if (!node)
    return
  // 用户滚离底部即暂停跟随;滚回底部附近自动恢复。
  autoFollowBottom.value
    = node.scrollHeight - node.clientHeight - node.scrollTop <= BOTTOM_LOCK_DISTANCE_PX
  updateScrollMaskState()
}

function followOrMask() {
  if (autoFollowBottom.value)
    scrollToBottom()
  else
    updateScrollMaskState()
}

let resizeObserver: ResizeObserver | null = null

watch(shouldRender, async (render) => {
  resizeObserver?.disconnect()
  resizeObserver = null
  if (!render) {
    autoFollowBottom.value = true
    scrollMaskState.value = EMPTY_SCROLL_MASK_STATE
    return
  }
  await nextTick()
  followOrMask()
  if (typeof ResizeObserver === "undefined")
    return
  // 流式追加时 scrollHeight 变化;同时监听容器与内容尺寸。
  resizeObserver = new ResizeObserver(() => followOrMask())
  if (scrollRef.value)
    resizeObserver.observe(scrollRef.value)
  if (contentRef.value)
    resizeObserver.observe(contentRef.value)
})

watch(() => props.content, async () => {
  if (!shouldRender.value)
    return
  await nextTick()
  followOrMask()
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})
</script>

<template>
  <CollapsibleContent
    :class="cn(
      'text-sm outline-none',
      'data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2',
      'data-[state=open]:slide-in-from-top-2',
      'data-[state=closed]:animate-out data-[state=open]:animate-in',
      props.class,
    )"
  >
    <div v-if="shouldRender" class="pt-1">
      <div
        ref="scrollRef"
        class="max-h-60 overflow-auto py-1 text-muted-foreground"
        :style="scrollMaskStyle"
        @scroll="onScroll"
      >
        <div ref="contentRef" class="min-w-0 break-words whitespace-pre-wrap">
          {{ props.content }}
        </div>
      </div>
    </div>
  </CollapsibleContent>
</template>
