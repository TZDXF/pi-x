<script setup lang="ts">
import { useI18n } from "vue-i18n"
import { AlertTriangle, Folder, FolderOpen, MoreHorizontal, Pencil, Pin, PinOff, Plus, X } from "@lucide/vue"
import { isDesktop } from "@/api/transport"
import { openPath } from "@/api/piClient"
import { useUiStore } from "@/stores/conversations"
import { useWorkspaceStore } from "@/stores/workspace"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"

defineProps<{
  path: string
  project: string
  ready: boolean
  collapsed: boolean
  error?: string
  disabled: boolean
  navigationDisabled: boolean
}>()
const emit = defineEmits<{
  toggle: []
  newSession: [path: string]
  editProject: [path: string]
  removeProject: [path: string]
}>()
const workspace = useWorkspaceStore()
const ui = useUiStore()
const { t } = useI18n()
async function openProjectFolder(path: string) {
  try {
    await openPath(path)
  } catch (e) {
    ui.pushToast(String(e), "error")
  }
}
</script>

<template>
  <section class="project-group mb-1 min-w-0 max-w-full">
    <ContextMenu>
      <ContextMenuTrigger as-child :disabled="disabled">
        <div
          class="project-heading relative flex items-center min-h-8 rounded-md pr-1 min-w-0 max-w-full hover:[background:color-mix(in_srgb,_var(--sidebar-accent)_60%,_transparent)]"
          :class="{
            selected: path === workspace.projectRoot(project),
            'drag-cursor': !disabled,
          }"
          :data-path="path"
        >
          <Button
            size="content"
            variant="project-row"
            class="project-row"
            :title="path"
            :aria-expanded="!collapsed"
            @click="emit('toggle')"
          >
            <FolderOpen v-if="!collapsed" :size="15" class="size-auto shrink-0" /><Folder
              v-else
              :size="15"
              class="size-auto shrink-0"
            /><span class="truncate">{{ workspace.projectName(path) }}</span>
            <AlertTriangle
              v-if="error === 'missing'"
              :size="14"
              class="size-auto shrink-0 text-amber-600 dark:text-amber-400"
              :aria-label="t('sidebar.projectDirMissing')"
              :title="t('sidebar.projectDirMissing')"
            />
          </Button>
          <Button
            variant="quiet"
            size="row-action"
            class="hover-action opacity-[0] disabled:opacity-[0] pointer-events-none [@media(hover:none)]:opacity-[1] [@media(hover:none)]:pointer-events-auto"
            :disabled="navigationDisabled || (!ready && path === project)"
            :title="t('sidebar.newSession')"
            :aria-label="`${t('sidebar.newSession')} · ${workspace.projectName(path)}`"
            @click="emit('newSession', path)"
            ><Plus :size="16" class="size-auto shrink-0"
          /></Button>
          <Pin
            v-if="workspace.pinnedProjects.includes(path)"
            :size="12"
            class="size-auto shrink-0 project-pin shrink-0 text-muted-foreground"
            :aria-label="t('workspace.pinned')"
          />
          <DropdownMenu>
            <DropdownMenuTrigger as-child
              ><Button
                variant="quiet"
                size="row-action"
                class="project-more hover-action w-6 h-6.5 opacity-[0] disabled:opacity-[0] pointer-events-none [@media(hover:none)]:opacity-[1] [@media(hover:none)]:pointer-events-auto"
                :disabled="disabled"
                :title="t('workspace.projectActions')"
                :aria-label="`${t('workspace.projectActions')} · ${workspace.projectName(path)}`"
                ><MoreHorizontal :size="16" class="size-auto shrink-0" /></Button
            ></DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="bottom" class="w-auto">
              <DropdownMenuItem @select="workspace.togglePin(path)"
                ><PinOff v-if="workspace.pinnedProjects.includes(path)" :size="14" class="size-auto shrink-0" /><Pin
                  v-else
                  :size="14"
                  class="size-auto shrink-0"
                />{{
                  workspace.pinnedProjects.includes(path) ? t("workspace.unpin") : t("workspace.pin")
                }}</DropdownMenuItem
              >
              <DropdownMenuItem @select="emit('editProject', path)"
                ><Pencil :size="14" class="size-auto shrink-0" />{{ t("projectDialog.editTitle") }}</DropdownMenuItem
              >
              <DropdownMenuItem
                :disabled="!isDesktop"
                :title="!isDesktop ? t('workspace.desktopOnly') : undefined"
                @select="openProjectFolder(path)"
                ><FolderOpen :size="14" class="size-auto shrink-0" />{{ t("workspace.openExplorer") }}</DropdownMenuItem
              >
              <DropdownMenuSeparator />
              <DropdownMenuItem
                class="text-destructive"
                :title="t('workspace.removeProjectHint')"
                @select="emit('removeProject', path)"
                ><X :size="14" />{{ t("workspace.removeProject") }}</DropdownMenuItem
              >
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        ><ContextMenuItem @select="workspace.togglePin(path)"
          ><PinOff v-if="workspace.pinnedProjects.includes(path)" :size="14" class="size-auto shrink-0" /><Pin
            v-else
            :size="14"
            class="size-auto shrink-0"
          />{{ workspace.pinnedProjects.includes(path) ? t("workspace.unpin") : t("workspace.pin") }}</ContextMenuItem
        ><ContextMenuItem @select="emit('editProject', path)"
          ><Pencil :size="14" class="size-auto shrink-0" />{{ t("projectDialog.editTitle") }}</ContextMenuItem
        ><ContextMenuItem
          :disabled="!isDesktop"
          :title="!isDesktop ? t('workspace.desktopOnly') : undefined"
          @select="openProjectFolder(path)"
          ><FolderOpen :size="14" class="size-auto shrink-0" />{{ t("workspace.openExplorer") }}</ContextMenuItem
        ><ContextMenuSeparator /><ContextMenuItem
          class="text-destructive"
          :title="t('workspace.removeProjectHint')"
          @select="emit('removeProject', path)"
          ><X :size="14" />{{ t("workspace.removeProject") }}</ContextMenuItem
        ></ContextMenuContent
      >
    </ContextMenu>
    <p
      v-if="!collapsed && error === 'missing'"
      role="alert"
      class="flex items-center gap-2 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
    >
      <AlertTriangle :size="14" class="shrink-0" />{{ t("sidebar.projectDirMissing") }}
    </p>
    <slot v-if="!collapsed && error !== 'missing'" />
  </section>
</template>

<style scoped>
.project-heading:is(:hover, :has(:focus-visible)) > .hover-action:not(:disabled) {
  opacity: 1;
  pointer-events: auto;
}
.hover-action:has([data-state="open"]) {
  opacity: 1;
  pointer-events: auto;
}
.project-more[data-state="open"] {
  background: var(--accent);
  color: var(--foreground);
}
.drag-cursor {
  cursor: grab;
}
.drag-cursor:active {
  cursor: grabbing;
}
.project-heading.drag-source {
  opacity: 0.45;
}
</style>
