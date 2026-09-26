<script setup lang="ts">
import { computed } from 'vue'
import { composerChipClass, composerChipText, composerParts } from '@/lib/composerTokens'
import { useSessionLabels } from '@/composables/useSessionLabels'

const props = defineProps<{ text: string }>()
const sessionLabels = useSessionLabels()
const parts = computed(() => composerParts(props.text, sessionLabels.value))
</script>

<template>
  <span class="whitespace-pre-wrap [overflow-wrap:anywhere]"><template v-for="(part, i) in parts" :key="i"><span
    v-if="part.kind !== 'text'"
    :aria-label="part.label"
    :title="part.raw"
    :class="composerChipClass"
  ><span class="truncate">{{ composerChipText(part) }}</span></span><template v-else>{{ part.raw }}</template></template></span>
</template>
