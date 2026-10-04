<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { RefreshCw } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { Message, MessageContent } from "@/components/ai-elements/message"
import type { RetryInfo } from "@/stores/session/types"

defineProps<{ retry: RetryInfo }>()
defineEmits<{ stop: [] }>()
const { t } = useI18n()
</script>

<template>
  <!-- Keep retry errors next to the conversation, not in the header. -->
  <Message from="assistant" role="status" aria-live="polite">
    <MessageContent class="w-full">
      <div
        class="flex w-full items-start gap-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-3.5 py-3 text-amber-800 shadow-sm dark:border-amber-400/20 dark:bg-amber-400/[0.08] dark:text-amber-200"
      >
        <span
          class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400"
          aria-hidden="true"
        >
          <RefreshCw :size="14" class="animate-spin" />
        </span>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p class="text-sm font-medium">{{ t("chat.retrying") }}</p>
            <span
              class="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300"
            >
              {{ t("chat.retryAttempt", { attempt: retry.attempt, maxAttempts: retry.maxAttempts }) }}
            </span>
          </div>
          <p
            class="mt-1 whitespace-pre-wrap text-xs leading-5 text-amber-700/85 [overflow-wrap:anywhere] dark:text-amber-200/80"
          >
            {{ retry.errorMessage || t("chat.retryUnknownError") }}
          </p>
        </div>
        <Button variant="outline" size="sm" class="h-7 shrink-0 text-xs" @click="$emit('stop')">
          {{ t("chat.abortRetry") }}
        </Button>
      </div>
    </MessageContent>
  </Message>
</template>
