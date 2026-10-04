<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { compactNumber } from "@/lib/format"
import type { CompactionEntry } from "@/stores/session/types"

/** compaction marker: a divider at the position history collapsed */
defineProps<{ entry: CompactionEntry }>()
const { t } = useI18n()
</script>

<template>
  <details class="group">
    <summary
      class="flex cursor-pointer list-none items-center gap-3 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden"
    >
      <span class="h-px flex-1 bg-border"></span>
      <span class="flex items-center gap-1.5">
        {{ t("chat.compacted") }}
        <template v-if="entry.tokensBefore">
          <span aria-hidden="true">&middot;</span>
          {{ compactNumber(entry.tokensBefore)
          }}<template v-if="entry.tokensAfter"> &rarr; {{ compactNumber(entry.tokensAfter) }}</template>
        </template>
      </span>
      <span class="h-px flex-1 bg-border"></span>
    </summary>
    <p
      class="mt-2 whitespace-pre-wrap rounded-lg bg-muted/50 px-3 py-2 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]"
    >
      {{ entry.summary }}
    </p>
  </details>
</template>
