<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { Pencil, Trash2 } from "@lucide/vue"
import { duplicateSessionFile, type SessionMeta } from "@/api/piClient"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import SessionContextMenuContent from "@/components/workspace/SessionContextMenuContent.vue"
import { useSidebarSessionActions } from "@/components/workspace/sidebar/useSidebarSessionActions"
import { useWorkspaceStore } from "@/stores/workspace"
import { useUiStore } from "@/stores/conversations"
import { copyWithToast } from "@/lib/clipboard"
import { isRemoteProject } from "@/lib/ssh"
import type { KanbanCard } from "@/lib/kanban"

const props = defineProps<{ card: KanbanCard; disabled?: boolean }>()
const emit = defineEmits<{ open: []; export: [file: string]; edit: []; delete: [] }>()
const { t } = useI18n()
const workspace = useWorkspaceStore()
const ui = useUiStore()
const cwd = computed(() => props.card.cwd || props.card.project)
const remote = computed(() => isRemoteProject(cwd.value) || isRemoteProject(props.card.project))
const session = computed<SessionMeta | null>(() => {
  if (!props.card.file) return null
  return (
    workspace.histories[cwd.value]?.find(row => row.file === props.card.file) ?? {
      file: props.card.file,
      id: props.card.id,
      cwd: cwd.value,
      title: props.card.title,
      preview: props.card.preview,
      mtimeMs: props.card.updatedAt,
    }
  )
})
const { renaming, title, saving, rename, saveTitle, archive } = useSidebarSessionActions({
  label: row => row.title || row.preview || t("sidebar.untitled"),
  disabled: () => !!props.disabled,
  navigationDisabled: () => !!props.disabled,
  resume: () => emit("open"),
  update: async (row, nextTitle, archived) => {
    await workspace.update(row, nextTitle, archived)
    await workspace.refresh(row.cwd)
  },
  onError: error => ui.pushToast(String(error), "error"),
})

async function duplicate() {
  const row = session.value
  if (!row || props.disabled || remote.value) return
  try {
    await duplicateSessionFile(row.file)
    ui.pushToast(t("workspace.duplicated"), "info")
    await workspace.refresh(row.cwd)
  } catch (error) {
    ui.pushToast(String(error), "error")
  }
}
</script>

<template>
  <ContextMenu>
    <ContextMenuTrigger as-child :disabled="disabled || saving || (card.status !== 'todo' && !session)">
      <slot />
    </ContextMenuTrigger>
    <ContextMenuContent v-if="card.status === 'todo'">
      <ContextMenuItem @select="emit('edit')">
        <Pencil :size="14" class="size-auto shrink-0" />{{ t("kanban.edit") }}
      </ContextMenuItem>
      <ContextMenuItem variant="destructive" @select="emit('delete')">
        <Trash2 :size="14" class="size-auto shrink-0" />{{ t("kanban.delete") }}
      </ContextMenuItem>
    </ContextMenuContent>
    <SessionContextMenuContent
      v-else-if="session"
      :remote="remote"
      :archived="session.archived"
      @open="emit('open')"
      @rename="rename(session)"
      @duplicate="duplicate"
      @copy-link="copyWithToast(ui, session.file, t('workspace.linkCopied'))"
      @export="emit('export', session.file)"
      @archive="archive(session)"
    />
  </ContextMenu>
  <Dialog :open="!!renaming" @update:open="!$event && (renaming = null)">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ t("workspace.rename") }}</DialogTitle>
        <DialogDescription class="sr-only">{{ t("workspace.renameDescription") }}</DialogDescription>
      </DialogHeader>
      <form class="space-y-4" @submit.prevent="saveTitle">
        <Input
          v-model="title"
          autofocus
          maxlength="120"
          :aria-label="t('workspace.title')"
          class="w-full rounded-lg border-border bg-background px-3 py-[9px] dark:bg-background h-auto"
        />
        <div class="flex justify-end gap-2">
          <Button variant="quiet" size="quiet" type="button" @click="renaming = null">
            {{ t("workspace.cancel") }}
          </Button>
          <Button size="workspace" :disabled="saving || !title.trim()">{{ t("workspace.save") }}</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>
