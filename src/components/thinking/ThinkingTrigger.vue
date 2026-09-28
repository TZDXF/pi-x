<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { BrainIcon, ChevronRightIcon } from "@lucide/vue"
import { CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useThinkingContext } from "./context"

interface Props {
  class?: HTMLAttributes["class"]
  streamingText?: string
}

const props = withDefaults(defineProps<Props>(), { streamingText: "" })

const { t } = useI18n()
const { isStreaming, isOpen, duration } = useThinkingContext()

// 收起态展示思考流式的最后一行非空内容,让头部摘要跟上最新 token。
function resolveStreamingSummary(text: string): { key: string; text: string } | null {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? ""
    if (line.length > 0) return { key: String(i), text: line }
  }
  return null
}

const streamingSummary = computed(() =>
  isStreaming.value && !isOpen.value ? resolveStreamingSummary(props.streamingText) : null,
)

const SUMMARY_MASK = "linear-gradient(to right, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)"
const summaryViewport = ref<HTMLElement | null>(null)
const summaryTextEl = ref<HTMLElement | null>(null)
const summaryOverflowing = ref(false)

// 摘要超宽后,普通 overflow-hidden 会固定显示旧前缀;每次增长把单行视口
// scrollLeft 推到最右,旧内容向左移出,最新 token 始终可见。
function syncSummaryViewport() {
  const viewport = summaryViewport.value
  if (!viewport || !streamingSummary.value) return
  summaryOverflowing.value = viewport.scrollWidth > viewport.clientWidth + 1
  viewport.scrollLeft = viewport.scrollWidth
}

let summaryObserver: ResizeObserver | null = null
let lastSummaryText: string | null = null

watch(streamingSummary, async summary => {
  // 浅比较：文本未变化时不重建 ResizeObserver，避免每个 token 都触发 disconnect/observe。
  const text = summary?.text ?? null
  if (text === lastSummaryText) return
  lastSummaryText = text
  summaryObserver?.disconnect()
  summaryObserver = null
  if (!summary) return
  await nextTick()
  syncSummaryViewport()
  if (typeof ResizeObserver === "undefined") return
  summaryObserver = new ResizeObserver(() => syncSummaryViewport())
  if (summaryViewport.value) summaryObserver.observe(summaryViewport.value)
  if (summaryTextEl.value) summaryObserver.observe(summaryTextEl.value)
})

onBeforeUnmount(() => {
  summaryObserver?.disconnect()
  summaryObserver = null
})

const label = computed(() => {
  if (isStreaming.value) {
    return isOpen.value && duration.value !== undefined
      ? t("blocks.thinkingSeconds", { seconds: duration.value })
      : t("blocks.thinking")
  }
  return duration.value === undefined ? t("blocks.thoughtFew") : t("blocks.thoughtSeconds", { seconds: duration.value })
})
</script>

<template>
  <CollapsibleTrigger
    :class="
      cn(
        'group/thinking inline-flex max-w-full min-w-0 items-center gap-2 self-start text-sm transition-colors',
        props.class,
      )
    "
  >
    <BrainIcon class="size-4 shrink-0 text-muted-foreground" />
    <span class="shrink-0 whitespace-nowrap text-muted-foreground">
      <Shimmer v-if="isStreaming" :duration="1" class="font-medium">
        {{ label }}
      </Shimmer>
      <span v-else class="font-medium">{{ label }}</span>
    </span>
    <template v-if="streamingSummary">
      <span class="shrink-0 text-muted-foreground/60">·</span>
      <span
        ref="summaryViewport"
        class="min-w-0 flex-1 overflow-hidden whitespace-nowrap text-muted-foreground"
        :style="summaryOverflowing ? { WebkitMaskImage: SUMMARY_MASK, maskImage: SUMMARY_MASK } : undefined"
      >
        <span :key="streamingSummary.key" ref="summaryTextEl" class="inline-block min-w-max">{{
          streamingSummary.text
        }}</span>
      </span>
    </template>
    <ChevronRightIcon
      :class="
        cn(
          'size-4 shrink-0 text-muted-foreground/70 transition-[opacity,transform] duration-200',
          isOpen ? 'rotate-90 opacity-100' : 'rotate-0 opacity-0 group-hover/thinking:opacity-100',
        )
      "
    />
  </CollapsibleTrigger>
</template>
