<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Block, Entry } from '@/stores/conversations'
import { conversationTurns } from '@/lib/conversationTimeline'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const props = defineProps<{ entries: Entry[]; partial: Block[] | null }>()
const emit = defineEmits<{ navigate: [id: number] }>()
const { t } = useI18n()
const turns = computed(() => conversationTurns(props.entries, props.partial))
const selected = ref<number | null>(null)
function navigate(id: number) {
  selected.value = id
  emit('navigate', id)
}
</script>

<template>
  <nav v-if="turns.length" class="conversation-timeline" :aria-label="t('chat.timeline')">
    <TooltipProvider :delay-duration="120">
      <ol class="timeline-track">
        <li v-for="(turn, index) in turns" :key="turn.id" class="timeline-item">
          <Tooltip>
            <TooltipTrigger as-child>
              <button type="button" class="timeline-node" :class="{ 'is-selected': selected === turn.id }"
                :aria-label="t('chat.timelineJump', { number: index + 1 }) + ': ' + (turn.question || t('chat.timelineImage'))"
                @click="navigate(turn.id)">
                <span class="timeline-dot" /><span class="timeline-number" aria-hidden="true">{{ index + 1 }}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" :side-offset="6" :collision-padding="16" class="timeline-preview">
              <div class="space-y-2">
                <p v-if="turn.question || !turn.answer" class="line-clamp-1 font-medium leading-snug">{{ turn.question || t('chat.timelineImage') }}</p>
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
.conversation-timeline { position: absolute; z-index: 10; left: 4px; top: 16px; bottom: 16px; width: 30px; overflow-y: auto; scrollbar-width: none; overscroll-behavior: contain; }
.conversation-timeline::-webkit-scrollbar { display: none; }
.timeline-track { display: flex; flex-direction: column; align-items: center; padding: 4px 0; margin: 0; list-style: none; }
.timeline-item { position: relative; }
.timeline-item:not(:last-child)::after { content: ''; position: absolute; width: 1px; background: var(--border); top: 13px; bottom: -13px; left: 50%; transform: translateX(-50%); pointer-events: none; }
.timeline-node { position: relative; z-index: 1; display: grid; place-items: center; width: 28px; height: 26px; border-radius: 7px; cursor: pointer; color: var(--muted-foreground); transition: background 180ms ease, color 180ms ease; }
.timeline-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--muted-foreground); box-shadow: 0 0 0 3px var(--background); transition: transform 200ms ease, background 200ms ease, box-shadow 200ms ease; }
.timeline-number { position: absolute; opacity: 0; font-size: 10px; font-weight: 600; transition: opacity 180ms ease; }
.timeline-node:hover, .timeline-node:focus-visible { color: var(--primary); background: var(--accent); outline: 2px solid var(--ring); outline-offset: -2px; }
.timeline-node:hover .timeline-dot, .timeline-node:focus-visible .timeline-dot { transform: scale(3); background: var(--accent); box-shadow: none; }
.timeline-node:hover .timeline-number, .timeline-node:focus-visible .timeline-number { opacity: 1; }
.timeline-node.is-selected .timeline-dot { background: var(--primary); }
.timeline-node.is-selected:hover .timeline-dot, .timeline-node.is-selected:focus-visible .timeline-dot { background: var(--accent); }
.timeline-preview { width: min(280px, calc(100vw - 64px)); max-width: 280px; padding: 12px; overflow-wrap: anywhere; animation-duration: 180ms; }
@media (prefers-reduced-motion: reduce) { *, *::after { transition: none !important; animation: none !important; } }
</style>
