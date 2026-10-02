<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { VueDraggable } from "vue-draggable-plus"
import { Layers } from "@lucide/vue"
import type { SessionMeta } from "@/api/piClient"
import type { QueuedPrompt } from "@/stores/session"
import { activeRuntimeId, findConversation, useSessionStore } from "@/stores/conversations"
import { useWorkspaceStore } from "@/stores/workspace"
import { Button } from "@/components/ui/button"
import SidebarPendingSessionRow from "./SidebarPendingSessionRow.vue"
import SidebarSavedSessionRow from "./SidebarSavedSessionRow.vue"
import { setSidebarSessionDragData } from "./useSidebarSessionOrdering"

defineProps<{
  path: string
  rows: SessionMeta[]
  orderedFiles: string[]
  pending: { runtimeId: string; cwd: string; promptQueue: QueuedPrompt[] }[]
  query: string
  disabled: boolean
  navigationDisabled: boolean
  queueNow: number
  showDraft: boolean
  draftWorktree?: boolean
  projectless?: boolean
  error?: string
  loading?: boolean
  hasHistory: boolean
}>()
const emit = defineEmits<{
  selectConversation: [runtimeId: string]
  reorder: [files: string[]]
  open: [session: SessionMeta]
  renameOnDoubleClick: [session: SessionMeta]
  rename: [session: SessionMeta]
  archive: [session: SessionMeta]
  duplicate: [session: SessionMeta]
  copyLink: [session: SessionMeta]
  export: [file: string]
  refresh: []
}>()
const { t } = useI18n()
const session = useSessionStore()
const workspace = useWorkspaceStore()
function setSessionDragData(transfer: DataTransfer, item: HTMLElement) {
  setSidebarSessionDragData(transfer, item, file => findConversation(file)?.runtimeId)
}
</script>

<template>
  <div class="session-list min-h-0 p-0 overflow-visible">
    <div
      v-if="showDraft"
      class="session-row active flex items-center gap-0.5 w-full pt-0 pr-1 pb-0 pl-7 rounded-md text-xs text-left relative min-h-8 m-0 min-w-0 max-w-full hover:[background:color-mix(in_srgb,_var(--sidebar-accent)_60%,_transparent)] [@media(pointer:coarse)]:min-h-9"
      aria-current="page"
    >
      <Layers
        v-if="draftWorktree"
        :size="13"
        class="shrink-0 text-muted-foreground"
        role="img"
        :aria-label="t('workspace.worktree')"
        :title="t('workspace.worktree')"
      />
      <span class="truncate">{{ t("chat.newSession") }}</span>
    </div>
    <SidebarPendingSessionRow
      v-for="conversation in pending"
      :key="conversation.runtimeId"
      :pending="conversation"
      :active="conversation.runtimeId === activeRuntimeId"
      :navigation-disabled="navigationDisabled"
      :queue-now="queueNow"
      :worktree="!projectless && workspace.isWorktree(conversation.cwd)"
      @select="emit('selectConversation', $event)"
    />
    <VueDraggable
      tag="div"
      :model-value="orderedFiles"
      :animation="150"
      :disabled="disabled || !!query"
      chosen-class="drag-source"
      :set-data="setSessionDragData"
      @update:model-value="emit('reorder', $event)"
    >
      <SidebarSavedSessionRow
        v-for="row in rows"
        :key="row.file"
        :s="row"
        :path="path"
        :active="row.file === session.sessionFile"
        :disabled="disabled"
        :navigation-disabled="navigationDisabled"
        :query="query"
        :queue-now="queueNow"
        :worktree="!projectless && workspace.isWorktree(row.cwd)"
        @open="emit('open', $event)"
        @rename-on-double-click="emit('renameOnDoubleClick', $event)"
        @rename="emit('rename', $event)"
        @archive="emit('archive', $event)"
        @duplicate="emit('duplicate', $event)"
        @copy-link="emit('copyLink', $event)"
        @export="emit('export', $event)"
      />
    </VueDraggable>
    <Button
      v-if="projectless ? !!error : error === 'failed'"
      variant="ghost"
      class="sidebar-empty p-3 text-xs leading-[1.8] text-muted-foreground h-auto"
      @click="emit('refresh')"
      >{{ projectless ? error : t("sidebar.loadFailed") }} · {{ t("sidebar.refresh") }}</Button
    >
    <p v-else-if="loading && !hasHistory" class="sidebar-empty p-3 text-xs leading-[1.8] text-muted-foreground h-auto">
      {{ t("sidebar.loading") }}
    </p>
    <p v-else-if="!rows.length && query" class="sidebar-empty p-3 text-xs leading-[1.8] text-muted-foreground h-auto">
      {{ t("sidebar.noMatch") }}
    </p>
  </div>
</template>

<style scoped>
.session-row.active,
.session-row.active:hover {
  background: var(--sidebar-accent);
  color: var(--sidebar-accent-foreground);
}
</style>
