<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { Block } from "@/stores/conversations"
import { appendPartial, type TimelineTurn } from "@/lib/conversationTimeline"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { compactNumber } from "@/lib/format"

const props = defineProps<{ turns: TimelineTurn[]; partial: Block[] | null }>()
const emit = defineEmits<{ navigate: [turn: TimelineTurn] }>()
const { t } = useI18n()
const turns = computed(() => {
  // Context-edit markers stay in the session data but are not shown in the UI.
  const list = props.turns.filter(turn => !turn.contextEdit).map(turn => ({ ...turn }))
  if (props.partial?.length && list.length) {
    // Streaming text belongs to the current question, never a compaction node.
    const last = [...list].reverse().find(turn => !turn.compaction)
    if (last) appendPartial(last, props.partial)
  }
  // Compaction nodes are not questions; keep numbering stable.
  let rank = 0
  return list.map(turn => ({ ...turn, rank: turn.compaction ? 0 : ++rank }))
})
const selected = ref<number | null>(null)
// 当轮次很多时压缩节点高度，保证时间线在可视区内完整显示：
// 默认 20px，最多压缩到 6px（圆点同步缩小）；仍放不下（超多
// 轮次）时回退为内部滚动，并以边缘渐隐提示还有更多节点。
const MAX_NODE_H = 20
const MIN_NODE_H = 6
const TRACK_PADDING = 4
const navRef = ref<HTMLElement | null>(null)
const nodeHeight = ref(MAX_NODE_H)
const scrollable = ref(false)
function updateNodeHeight() {
  const available = (navRef.value?.clientHeight ?? 0) - TRACK_PADDING
  const count = turns.value.length
  if (available <= 0 || count <= 0) return
  nodeHeight.value = Math.max(MIN_NODE_H, Math.min(MAX_NODE_H, Math.floor(available / count)))
  scrollable.value = count * nodeHeight.value + TRACK_PADDING > (navRef.value?.clientHeight ?? 0)
}
let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  resizeObserver = new ResizeObserver(updateNodeHeight)
  if (navRef.value) resizeObserver.observe(navRef.value)
  updateNodeHeight()
  viewportEl = navRef.value?.parentElement?.querySelector<HTMLElement>("[data-reka-scroll-area-viewport]") ?? null
  viewportEl?.addEventListener("scroll", onViewportScroll, { passive: true })
  nextTick(updateCurrent)
})
onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  viewportEl?.removeEventListener("scroll", onViewportScroll)
  if (scrollFrame) cancelAnimationFrame(scrollFrame)
})
watch(() => turns.value.length, updateNodeHeight)
watch(turns, () => nextTick(updateCurrent))
function navigate(turn: TimelineTurn) {
  selected.value = turn.id
  emit("navigate", turn)
}
// 跟随会话滚动条指示当前位置：视口顶部越过的最后一个问题即为当前轮次，
// 该节点按 hover 样式显示数字（不额外高亮）。时间线位于 Conversation 的
// overlay 内，滚动视口是其父级 ScrollAreaRoot 下的 reka-ui viewport。
const currentId = ref<number | null>(null)
let viewportEl: HTMLElement | null = null
let scrollFrame = 0
function updateCurrent() {
  const viewport = viewportEl
  if (!viewport) return
  const threshold = viewport.getBoundingClientRect().top + Math.min(80, viewport.clientHeight / 3)
  let current: number | null = null
  for (const turn of turns.value) {
    if (turn.compaction || turn.entryId == null) continue
    const el = viewport.querySelector<HTMLElement>(`[data-message-id="${turn.entryId}"]`)
    // 未物化的轮次没有 DOM 锚点，跳过；消息自上而下排列，越过阈值即可停止。
    if (!el) continue
    if (el.getBoundingClientRect().top > threshold) break
    current = turn.id
  }
  currentId.value = current
}
function onViewportScroll() {
  if (scrollFrame) return
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0
    updateCurrent()
  })
}
</script>

<template>
  <nav
    ref="navRef"
    v-if="turns.length"
    class="conversation-timeline"
    :class="{ 'is-scrollable': scrollable }"
    :aria-label="t('chat.timeline')"
  >
    <TooltipProvider :delay-duration="120">
      <ol class="timeline-track" :style="{ '--node-h': nodeHeight + 'px' }">
        <li v-for="turn in turns" :key="turn.id" class="timeline-item">
          <Tooltip>
            <TooltipTrigger as-child>
              <button
                type="button"
                class="timeline-node"
                :class="{
                  'is-selected': selected === turn.id,
                  'is-compaction': !!turn.compaction,
                  'is-current': currentId === turn.id,
                }"
                :aria-label="
                  turn.compaction
                    ? t('chat.timelineCompaction')
                    : t('chat.timelineJump', { number: turn.rank }) + ': ' + (turn.question || t('chat.timelineImage'))
                "
                @click="navigate(turn)"
              >
                <template v-if="turn.compaction || turn.contextEdit"><span class="timeline-dash" /></template>
                <template v-else
                  ><span class="timeline-dot" /><span class="timeline-number" aria-hidden="true">{{
                    turn.rank
                  }}</span></template
                >
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" :side-offset="6" :collision-padding="16" class="timeline-preview">
              <div v-if="turn.compaction" class="space-y-2">
                <p class="line-clamp-1 font-medium leading-snug">{{ t("chat.compacted") }}</p>
                <p v-if="turn.compaction.tokensBefore" class="leading-snug opacity-80">
                  {{ compactNumber(turn.compaction.tokensBefore)
                  }}<template v-if="turn.compaction.tokensAfter">
                    → {{ compactNumber(turn.compaction.tokensAfter) }}</template
                  >
                </p>
              </div>
              <div v-else class="space-y-2">
                <p v-if="turn.question || !turn.answer" class="line-clamp-1 font-medium leading-snug">
                  {{ turn.question || t("chat.timelineImage") }}
                </p>
                <p v-if="turn.answer" class="line-clamp-3 leading-snug opacity-80">{{ turn.answer }}</p>
              </div>
            </TooltipContent>
          </Tooltip>
        </li>
      </ol>
    </TooltipProvider>
  </nav>
</template>

<style scoped>
.conversation-timeline {
  position: absolute;
  z-index: 10;
  left: 4px;
  top: 16px;
  bottom: 16px;
  width: 30px;
  overflow-y: auto;
  scrollbar-width: none;
  overscroll-behavior: contain;
}
.conversation-timeline::-webkit-scrollbar {
  display: none;
}
.conversation-timeline.is-scrollable {
  mask-image: linear-gradient(to bottom, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%);
}
.timeline-track {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 2px 0;
  margin: 0;
  list-style: none;
}
.timeline-item {
  position: relative;
}
.timeline-item:not(:last-child)::after {
  content: "";
  position: absolute;
  width: 1px;
  background: var(--border);
  top: 50%;
  height: var(--node-h, 20px);
  left: 50%;
  transform: translateX(-50%);
  pointer-events: none;
}
.timeline-node {
  position: relative;
  z-index: 1;
  display: grid;
  place-items: center;
  width: 28px;
  height: var(--node-h, 20px);
  border-radius: 7px;
  cursor: pointer;
  color: var(--muted-foreground);
  transition:
    background 180ms ease,
    color 180ms ease;
}
.timeline-dot {
  width: clamp(2px, calc(var(--node-h, 20px) * 0.35), 6px);
  height: clamp(2px, calc(var(--node-h, 20px) * 0.35), 6px);
  border-radius: 50%;
  background: var(--muted-foreground);
  box-shadow: 0 0 0 3px var(--background);
  transition:
    transform 200ms ease,
    background 200ms ease,
    box-shadow 200ms ease;
}
.timeline-number {
  position: absolute;
  opacity: 0;
  font-size: 10px;
  font-weight: 600;
  transition: opacity 180ms ease;
}
.timeline-node:hover,
.timeline-node:focus-visible {
  color: var(--primary);
  background: var(--accent);
  outline: 2px solid var(--ring);
  outline-offset: -2px;
}
.timeline-node:hover .timeline-dot,
.timeline-node:focus-visible .timeline-dot {
  transform: scale(2.5);
  background: var(--accent);
  box-shadow: none;
}
.timeline-node:hover .timeline-number,
.timeline-node:focus-visible .timeline-number {
  opacity: 1;
}
/* 当前位置：像 hover 一样只露出数字，不显示圆点也不高亮；
   悬停时恢复圆点，保持原有 hover 观感。 */
.timeline-node.is-current .timeline-number {
  opacity: 1;
}
.timeline-node.is-current .timeline-dot {
  opacity: 0;
}
.timeline-node.is-current:hover .timeline-dot,
.timeline-node.is-current:focus-visible .timeline-dot {
  opacity: 1;
}
.timeline-node.is-selected .timeline-dot {
  background: var(--primary);
}
.timeline-node.is-selected:hover .timeline-dot,
.timeline-node.is-selected:focus-visible .timeline-dot {
  background: var(--accent);
}
.timeline-dash {
  width: clamp(6px, calc(var(--node-h, 20px) * 0.6), 12px);
  height: 2px;
  border-radius: 1px;
  background: var(--muted-foreground);
  box-shadow: 0 0 0 3px var(--background);
  transition:
    transform 200ms ease,
    background 200ms ease,
    box-shadow 200ms ease;
}
.timeline-node:hover .timeline-dash,
.timeline-node:focus-visible .timeline-dash {
  transform: scaleX(1.5);
  background: var(--accent);
  box-shadow: none;
}
.timeline-node.is-selected .timeline-dash {
  background: var(--primary);
}
.timeline-preview {
  width: min(280px, calc(100vw - 64px));
  max-width: 280px;
  padding: 12px;
  overflow-wrap: anywhere;
  animation-duration: 180ms;
}
@media (prefers-reduced-motion: reduce) {
  *,
  *::after {
    transition: none !important;
    animation: none !important;
  }
}
</style>
