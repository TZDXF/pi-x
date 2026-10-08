<script setup lang="ts">
import { useI18n } from "vue-i18n"
import type { ModelChangeEntry } from "@/stores/session/types"

/** model-change marker: a divider where the conversation switched models */
defineProps<{ entry: ModelChangeEntry }>()
const { t } = useI18n()
</script>

<template>
  <div class="flex items-center gap-3 text-xs text-muted-foreground" role="status">
    <span class="h-px flex-1 bg-border"></span>
    <span class="flex items-center gap-1.5">
      {{ t("chat.modelChangeMarker") }}
      <template v-if="entry.provider || entry.modelId">
        <span aria-hidden="true">&middot;</span>
        <span class="font-mono">{{ [entry.provider, entry.modelId].filter(Boolean).join("/") }}</span>
      </template>
    </span>
    <span class="h-px flex-1 bg-border"></span>
  </div>
</template>
