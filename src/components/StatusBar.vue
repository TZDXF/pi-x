<script setup lang="ts">
import { computed } from "vue"
import { sessionFor, uiFor, activeRuntimeId } from "@/stores/conversations"

const props = defineProps<{
  /** 所属会话 id；缺省跟随当前激活会话，分屏时由 ChatView 传入所属窗格会话。 */
  sessionId?: string
}>()
const session = sessionFor(props.sessionId ?? activeRuntimeId.value)
const ui = uiFor(props.sessionId ?? activeRuntimeId.value)

const totalCost = computed(() => session.stats?.cost ?? session.lastUsage?.cost?.total ?? 0)
const statusText = computed(() => Object.values(ui.statusEntries).join(" · "))
</script>

<template>
  <div class="text-muted-foreground flex flex-wrap items-center gap-3 px-1 font-mono text-[10px]">
    <span v-if="statusText" class="text-foreground">{{ statusText }}</span>
    <span v-if="totalCost">${{ totalCost.toFixed(4) }}</span>
  </div>
</template>
