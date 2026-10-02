<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { Clock } from "@lucide/vue"
import type { QueuedPrompt } from "@/stores/session"
import type { SessionRunStatus } from "@/stores/sessionRunStatus"
import { sidebarQueueTitle } from "./useSidebarSessionStatus"

const props = defineProps<{ status?: SessionRunStatus; queue?: QueuedPrompt[]; now: number }>()
const { t } = useI18n()
const queueTitle = computed(() =>
  sidebarQueueTitle(props.queue, props.now, t("chat.queuedPrompts"), time => t("chat.sendCountdown", { time })),
)
</script>

<template>
  <span
    v-if="status"
    class="session-status absolute left-[7px] top-1/2 -translate-y-1/2 inline-flex w-3.5 items-center justify-center text-muted-foreground"
    :class="`session-status-${status}`"
    role="status"
    :aria-label="t(`sidebar.status.${status}`)"
    :title="t(`sidebar.status.${status}`)"
  >
    <span v-if="status === 'running'" class="session-running" aria-hidden="true" />
    <span v-else class="session-status-dot w-1.5 h-1.5 rounded-full bg-current" aria-hidden="true" />
  </span>
  <span
    v-if="queue?.length"
    class="session-queue-status absolute top-1/2 -translate-y-1/2 inline-flex w-3.5 items-center justify-center text-muted-foreground"
    :class="status ? 'left-[23px]' : 'left-[7px]'"
    role="status"
    :title="queueTitle"
    :aria-label="queueTitle"
    ><Clock class="size-3"
  /></span>
</template>

<style scoped>
.session-running {
  display: block;
  width: 10px;
  height: 10px;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: session-status-spin 1s linear infinite;
}
@keyframes session-status-spin {
  to {
    transform: rotate(360deg);
  }
}
.session-status-completed {
  color: var(--success);
}
.session-status-error {
  color: var(--destructive);
}
</style>
