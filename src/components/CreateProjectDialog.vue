<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog"
import { FolderPlus, X } from "@lucide/vue"
import { isDesktop } from "@/api/transport"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useWorkspaceStore, type ProjectGroup } from "@/stores/workspace"

const props = defineProps<{ open: boolean; editPath?: string | null }>()
const emit = defineEmits<{ close: []; save: [group: ProjectGroup] }>()
const { t } = useI18n()
const workspace = useWorkspaceStore()
const title = ref("")
const folders = ref<string[]>([])
const primary = ref("")
const error = ref("")
const adding = ref(false)
const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path
const valid = computed(() => !!title.value.trim() && folders.value.length > 0 && folders.value.includes(primary.value))

watch(() => [props.open, props.editPath] as const, ([open]) => {
  if (open) {
    const group = props.editPath ? workspace.projectGroups[props.editPath] : null
    title.value = group?.name || (props.editPath ? workspace.projectName(props.editPath) : "")
    folders.value = group ? [...group.folders] : props.editPath ? [props.editPath] : []
    primary.value = group?.primary || props.editPath || ""
    error.value = ""
  }
})

async function addFolder() {
  if (adding.value) return
  adding.value = true
  try {
    const result = isDesktop
      ? await openFolderDialog({ directory: true, title: t("welcome.openFolderTitle") })
      : window.prompt(t("settings.remoteProject"))
    if (typeof result !== "string" || !result.trim()) return
    const path = result.trim()
    if (!props.open || folders.value.includes(path)) return
    if (folders.value.length >= 32) { error.value = t("projectDialog.tooManyFolders"); return }
    if (workspace.projects.some(existing => existing !== props.editPath && existing === path)
      || Object.entries(workspace.projectGroups).some(([root, group]) => root !== props.editPath && group.folders.includes(path))) {
      error.value = t("projectDialog.alreadyAdded")
      return
    }
    error.value = ""
    folders.value.push(path)
    if (!primary.value) primary.value = path
    if (!title.value.trim() && folders.value.length === 1) title.value = folderName(path)
  } catch (e) {
    error.value = String(e)
  } finally {
    adding.value = false
  }
}

function removeFolder(path: string) {
  folders.value = folders.value.filter(folder => folder !== path)
  if (primary.value === path) primary.value = folders.value[0] || ""
}

function submit() {
  if (!valid.value) return
  emit("save", { name: title.value.trim(), folders: [...folders.value], primary: primary.value })
}
</script>

<template>
  <Dialog :open="props.open" @update:open="value => { if (!value) emit('close') }">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader><DialogTitle>{{ t(props.editPath ? "projectDialog.editTitle" : "projectDialog.title") }}</DialogTitle></DialogHeader>
      <form class="space-y-5" @submit.prevent="submit">
        <label class="block space-y-2 text-sm font-medium" for="project-name">
          {{ t("projectDialog.name") }}
          <Input id="project-name" v-model="title" autofocus maxlength="120" :placeholder="t('projectDialog.namePlaceholder')" />
        </label>
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-sm font-medium">{{ t("projectDialog.folders") }}</span>
            <Button type="button" variant="outline" size="sm" :disabled="adding" @click="addFolder"><FolderPlus :size="15" />{{ t("projectDialog.addFolder") }}</Button>
          </div>
          <p v-if="!folders.length" class="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">{{ t("projectDialog.empty") }}</p>
          <div v-else class="max-h-64 space-y-1 overflow-y-auto" role="radiogroup" :aria-label="t('projectDialog.primaryHint')">
            <div v-for="path in folders" :key="path" class="flex items-center gap-2 rounded-md border px-3 py-2">
              <label class="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                <input v-model="primary" type="radio" name="primary-project" :value="path" :aria-label="`${t('projectDialog.primary')} · ${path}`" />
                <span class="min-w-0 flex-1"><span class="block truncate text-sm font-medium">{{ folderName(path) }}</span><span class="block truncate text-xs text-muted-foreground" :title="path">{{ path }}</span></span>
                <span v-if="primary === path" class="shrink-0 text-xs text-muted-foreground">{{ t("projectDialog.primary") }}</span>
              </label>
              <Button type="button" variant="ghost" size="icon-sm" :aria-label="`${t('projectDialog.removeFolder')} · ${path}`" @click="removeFolder(path)"><X :size="15" /></Button>
            </div>
          </div>
          <p class="text-xs text-muted-foreground">{{ t("projectDialog.primaryHint") }}</p>
        </div>
        <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
        <div class="flex justify-end gap-2"><Button type="button" variant="outline" @click="emit('close')">{{ t("common.cancel") }}</Button><Button type="submit" :disabled="!valid">{{ t(props.editPath ? "projectDialog.save" : "projectDialog.create") }}</Button></div>
      </form>
    </DialogContent>
  </Dialog>
</template>
