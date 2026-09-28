<script setup lang="ts">
import { computed } from "vue"
import { useSessionStore } from "@/stores/conversations"
import { useUiStore } from "@/stores/conversations"

const session = useSessionStore()
const ui = useUiStore()

const totalCost = computed(() => session.stats?.cost ?? session.lastUsage?.cost?.total ?? 0)
const statusText = computed(() => Object.values(ui.statusEntries).join(" · "))
</script>

<template>
  <div class="text-muted-foreground flex flex-wrap items-center gap-3 px-1 font-mono text-[10px]">
    <span v-if="statusText" class="text-foreground">{{ statusText }}</span>
    <span v-if="totalCost">${{ totalCost.toFixed(4) }}</span>
  </div>
</template>
