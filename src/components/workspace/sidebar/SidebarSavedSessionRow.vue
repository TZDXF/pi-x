<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { Archive, Copy, FileDown, Layers, Link, Pencil } from "@lucide/vue"
import type { SessionMeta } from "@/api/piClient"
import { findConversation } from "@/stores/conversations"
import { sessionRunStatus } from "@/stores/sessionRunStatus"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import SidebarSessionStatus from "./SidebarSessionStatus.vue"

const props = defineProps<{
  s: SessionMeta
  path: string
  active: boolean
  disabled: boolean
  navigationDisabled: boolean
  query: string
  queueNow: number
  worktree: boolean
  /** 远程项目会话：元数据写操作（重命名/归档/删除等本地文件命令）入口隐藏（契约 §2.4）。 */
  remote?: boolean
}>()
const emit = defineEmits<{
  open: [session: SessionMeta]
  renameOnDoubleClick: [session: SessionMeta]
  rename: [session: SessionMeta]
  archive: [session: SessionMeta]
  duplicate: [session: SessionMeta]
  copyLink: [session: SessionMeta]
  export: [file: string]
}>()
const { t } = useI18n()
const label = computed(() => props.s.title || props.s.preview || t("sidebar.untitled"))
const status = computed(() => sessionRunStatus(props.s.file, props.path))
const queue = computed(() => findConversation(props.s.file, props.path)?.promptQueue)
</script>

<template>
  <ContextMenu>
    <ContextMenuTrigger as-child :disabled="disabled">
      <div
        class="session-row group/session flex items-center gap-0.5 w-full pt-0 pr-1 pb-0 rounded-md text-xs text-left relative min-h-8 m-0 min-w-0 max-w-full hover:[background:color-mix(in_srgb,_var(--sidebar-accent)_60%,_transparent)] [@media(pointer:coarse)]:min-h-9"
        :aria-current="active ? 'page' : undefined"
        :class="{
          active: active,
          'drag-cursor': !disabled && !query,
          'pl-11': !!(status && queue?.length),
          'pl-7': !(status && queue?.length),
        }"
        :data-file="s.file"
        :data-path="path"
      >
        <SidebarSessionStatus :status="status" :queue="queue" :now="queueNow" />
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
          :aria-current="active ? 'page' : undefined"
          :disabled="navigationDisabled"
          :title="label"
          @click="emit('open', s)"
          @dblclick.stop="!remote && emit('renameOnDoubleClick', s)"
          >{{ label }}</Button
        >
        <Button
          v-if="!remote"
          variant="quiet"
          size="row-action"
          class="session-archive hover-action absolute right-1 top-[50%] [transform:translateY(-50%)] z-[1] opacity-[0] disabled:opacity-[0] pointer-events-none [@media(hover:none)]:opacity-[1] [@media(hover:none)]:pointer-events-auto"
          :disabled="disabled"
          :title="s.archived ? t('workspace.restore') : t('workspace.archive')"
          :aria-label="s.archived ? t('workspace.restore') : t('workspace.archive')"
          @click="emit('archive', s)"
          ><Archive :size="14" class="size-auto shrink-0"
        /></Button>
      </div>
    </ContextMenuTrigger>
    <!-- 远程项目：右键菜单仅保留“打开”（契约 §2.4） -->
    <ContextMenuContent v-if="remote">
      <ContextMenuItem @select="emit('open', s)"
        ><Link :size="14" class="size-auto shrink-0" />{{ t("workspace.open") }}</ContextMenuItem
      ></ContextMenuContent
    >
    <ContextMenuContent v-else
      ><ContextMenuItem @select="emit('rename', s)"
        ><Pencil :size="14" class="size-auto shrink-0" />{{ t("workspace.rename") }}</ContextMenuItem
      ><ContextMenuItem @select="emit('duplicate', s)"
        ><Copy :size="14" class="size-auto shrink-0" />{{ t("workspace.duplicate") }}</ContextMenuItem
      ><ContextMenuItem @select="emit('copyLink', s)"
        ><Link :size="14" class="size-auto shrink-0" />{{ t("workspace.copyLink") }}</ContextMenuItem
      ><ContextMenuSeparator /><ContextMenuItem @select="emit('export', s.file)"
        ><FileDown :size="14" class="size-auto shrink-0" />{{ t("chat.export") }}</ContextMenuItem
      ></ContextMenuContent
    >
  </ContextMenu>
</template>

<style scoped>
.session-row.active {
  background: var(--sidebar-accent);
  color: var(--sidebar-accent-foreground);
}
.session-row time {
  margin-left: auto;
  white-space: nowrap;
  font-size: 10px;
  color: var(--muted-foreground);
}
.session-row.active:hover {
  background: var(--sidebar-accent);
  color: var(--sidebar-accent-foreground);
}
.session-row:is(:hover, :has(:focus-visible)) .session-archive:not(:disabled) {
  opacity: 1;
  pointer-events: auto;
}
.session-row:has(.session-archive:not(:disabled)):is(:hover, :has(:focus-visible)) .session-link {
  margin-right: 28px;
}
@media (hover: none) {
  .session-row:has(.session-archive:not(:disabled)) .session-link {
    margin-right: 28px;
    padding-right: 0;
  }
}
@media (pointer: coarse) {
  .session-row:has(.session-archive:not(:disabled)) .session-link {
    margin-right: 36px;
    padding-right: 0;
  }
}
.drag-cursor {
  cursor: grab;
}
.drag-cursor:active {
  cursor: grabbing;
}
.session-row.drag-source {
  opacity: 0.45;
}
</style>
