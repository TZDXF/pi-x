<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { Layers } from "@lucide/vue"
import type { QueuedPrompt } from "@/stores/session"
import { Button } from "@/components/ui/button"
import SidebarSessionStatus from "./SidebarSessionStatus.vue"

defineProps<{
  pending: { runtimeId: string; promptQueue: QueuedPrompt[] }
  active: boolean
  navigationDisabled: boolean
  queueNow: number
  worktree: boolean
}>()
const emit = defineEmits<{ select: [runtimeId: string] }>()
const { t } = useI18n()
</script>

<template>
  <div
    class="session-row relative flex min-h-8 min-w-0 items-center gap-1 rounded-md pl-7 pr-2 text-xs"
    :class="{ active: active }"
  >
    <SidebarSessionStatus :queue="pending.promptQueue" :now="queueNow" />
    <Layers
      v-if="worktree"
      :size="13"
      class="shrink-0 text-muted-foreground"
      role="img"
      :aria-label="t('workspace.worktree')"
      :title="t('workspace.worktree')"
    />
    <Button
      size="content"
      variant="session-link"
      class="session-link"
      :disabled="navigationDisabled"
      :aria-current="active ? 'page' : undefined"
      :title="pending.promptQueue[0]?.text || t('chat.newSession')"
      @click="emit('select', pending.runtimeId)"
      >{{ pending.promptQueue[0]?.text || t("chat.newSession") }}</Button
    >
  </div>
</template>

<style scoped>
.session-row.active,
.session-row.active:hover {
  background: var(--sidebar-accent);
  color: var(--sidebar-accent-foreground);
}
</style>
