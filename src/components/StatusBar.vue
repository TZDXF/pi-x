<script setup lang="ts">
import { computed } from "vue"
import { useSessionStore } from "@/stores/session"
import { useUiStore } from "@/stores/ui"

const session = useSessionStore()
const ui = useUiStore()

const contextPercent = computed(() => session.stats?.contextUsage?.percent ?? null)
const totalCost = computed(() => session.stats?.cost ?? session.lastUsage?.cost?.total ?? 0)
const totalTokens = computed(() => session.stats?.tokens?.total ?? session.lastUsage?.totalTokens ?? 0)
const modelLabel = computed(() => {
  const m = session.currentModel
  return m ? `${m.provider}/${m.name}` : "no model"
})

const statusText = computed(() => Object.values(ui.statusEntries).join(" · "))
</script>

<template>
  <div class="text-muted-foreground flex items-center gap-3 font-mono text-[11px]">
    <span v-if="statusText" class="text-foreground">{{ statusText }}</span>
    <span class="truncate">{{ modelLabel }}</span>
    <span>think:{{ session.thinkingLevel }}</span>
    <span v-if="contextPercent !== null">ctx {{ contextPercent }}%</span>
    <span v-if="totalTokens">↑↓ {{ totalTokens.toLocaleString() }}</span>
    <span v-if="totalCost">${{ totalCost.toFixed(4) }}</span>
    <span v-if="session.pendingCount" class="text-amber-500">queue {{ session.pendingCount }}</span>
  </div>
</template>
