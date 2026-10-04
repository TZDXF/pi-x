<script setup lang="ts">
import { useI18n } from "vue-i18n"
import type { CustomEntry } from "@/stores/session/types"

/** unknown extension entry: low-key placeholder so custom session
 *  entries neither break nor clutter the conversation */
defineProps<{ entry: CustomEntry }>()
const { t } = useI18n()
</script>

<template>
  <div class="flex items-center gap-3 text-xs text-muted-foreground/70" role="status">
    <span class="h-px flex-1 bg-border"></span>
    <span>{{ t("chat.customEntry", { type: entry.customType }) }}</span>
    <span class="h-px flex-1 bg-border"></span>
  </div>
</template>
