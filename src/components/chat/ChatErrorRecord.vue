<script setup lang="ts">
import { CircleAlert } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import { formatMessageTime } from "@/lib/format"

defineProps<{
  text: string
  title?: string
  timestamp?: number
}>()
const { t } = useI18n()
</script>

<template>
  <div
    role="alert"
    data-error-record
    class="not-prose min-w-0 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-sm"
  >
    <div class="flex items-center gap-2 text-destructive">
      <CircleAlert class="size-4 shrink-0" />
      <span class="font-medium">{{ title || t("chat.errorLabel") }}</span>
      <time v-if="timestamp" class="ml-auto text-xs text-muted-foreground">
        {{ formatMessageTime(timestamp) }}
      </time>
    </div>
    <p class="mt-1.5 whitespace-pre-wrap break-words text-foreground/80 [overflow-wrap:anywhere]">{{ text }}</p>
  </div>
</template>
