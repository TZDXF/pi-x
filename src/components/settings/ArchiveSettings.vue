<script setup lang="ts">
/** Archived sessions page: grouped by project, with restore and delete actions. */
import { computed, onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { ask } from "@tauri-apps/plugin-dialog"
import { Archive, ArchiveRestore, Folder, RefreshCw, RotateCw, Trash2 } from "@lucide/vue"
import { deleteSession, listArchivedSessions, type SessionMeta } from "@/api/piClient"
import { Button } from "@/components/ui/button"
import { useUiStore } from "@/stores/conversations"
import { useWorkspaceStore } from "@/stores/workspace"

const { t } = useI18n()
const ui = useUiStore()
const workspace = useWorkspaceStore()

const sessions = ref<SessionMeta[]>([])
const loading = ref(false)
const busy = ref<string | null>(null) // file currently being restored/deleted
const error = ref("")

const projectName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path
const label = (s: SessionMeta) => s.title || s.preview || t("sidebar.untitled")
const when = (s: SessionMeta) => new Date(s.mtimeMs).toLocaleString()

interface ArchiveGroup { cwd: string; name: string; rows: SessionMeta[] }
const groups = computed<ArchiveGroup[]>(() => {
  const byProject = new Map<string, SessionMeta[]>()
  for (const s of sessions.value) {
    const rows = byProject.get(s.cwd) ?? []
    rows.push(s)
    byProject.set(s.cwd, rows)
  }
  return [...byProject.entries()]
    .map(([cwd, rows]) => ({
      cwd,
      name: projectName(cwd),
      rows: rows.sort((a, b) => b.mtimeMs - a.mtimeMs),
    }))
    .sort((a, b) => {
      const ma = Math.max(...a.rows.map(r => r.mtimeMs))
      const mb = Math.max(...b.rows.map(r => r.mtimeMs))
      return mb - ma
    })
})

async function load() {
  loading.value = true
  error.value = ""
  try {
    sessions.value = await listArchivedSessions()
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

/** Un-archive; the session reappears in its project's sidebar list. */
async function restore(s: SessionMeta) {
  if (busy.value) return
  busy.value = s.file
  try {
    await workspace.update(s, s.title || null, false)
    sessions.value = sessions.value.filter(row => row.file !== s.file)
    ui.pushToast(t("sessionArchive.restored"), "info")
  } catch (e) {
    ui.pushToast(String(e), "error")
  } finally {
    busy.value = null
  }
}

async function remove(s: SessionMeta) {
  if (busy.value) return
  const confirmed = await ask(t("sessionArchive.deleteConfirm", { name: label(s) }), {
    title: t("sessionArchive.title"),
    okLabel: t("sessionArchive.delete"),
    cancelLabel: t("common.cancel"),
  })
  if (!confirmed) return
  busy.value = s.file
  try {
    await deleteSession(s.file)
    workspace.removeSession(s.file)
    sessions.value = sessions.value.filter(row => row.file !== s.file)
    ui.pushToast(t("sessionArchive.deleted"), "info")
  } catch (e) {
    ui.pushToast(String(e), "error")
  } finally {
    busy.value = null
  }
}

onMounted(load)
</script>

<template>
  <div class="flex items-center justify-between">
    <Button variant="outline" size="sm" class="h-auto gap-2 px-3 py-1.5 text-xs" :disabled="loading" @click="load">
      <RotateCw :size="14" :class="{ 'animate-spin': loading }" />
      {{ t("sessionArchive.refresh") }}
    </Button>
    <p class="text-xs text-muted-foreground">
      {{ t("sessionArchive.count", { count: sessions.length }) }}
    </p>
  </div>

  <p v-if="error" class="text-sm text-destructive">
    {{ t("sessionArchive.loadFailed") }}
    <button class="underline underline-offset-2" @click="load">
      {{ t("sessionArchive.reload") }}
    </button>
    <span class="block break-all font-mono text-xs opacity-70">{{ error }}</span>
  </p>
  <p v-else-if="loading && !sessions.length" class="text-sm text-muted-foreground">
    {{ t("sessionArchive.loading") }}
  </p>
  <p v-else-if="!groups.length" class="flex items-center gap-2 py-8 text-sm text-muted-foreground">
    <Archive :size="16" />
    {{ t("sessionArchive.empty") }}
  </p>

  <section v-for="group in groups" :key="group.cwd" class="archive-group">
    <header class="flex items-center gap-2 border-b pb-2">
      <Folder :size="15" class="shrink-0 text-muted-foreground" />
      <h3 class="text-sm font-medium" :title="group.cwd">{{ group.name }}</h3>
      <span class="text-xs text-muted-foreground">
        {{ t("sessionArchive.projectSessions", { count: group.rows.length }) }}
      </span>
    </header>
    <ul class="divide-y">
      <li v-for="s in group.rows" :key="s.file" class="archive-row">
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm" :title="label(s)">{{ label(s) }}</p>
          <p class="text-xs text-muted-foreground">{{ when(s) }}</p>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            class="h-auto gap-1.5 px-2 py-1.5 text-xs"
            :disabled="!!busy"
            :title="t('sessionArchive.restore')"
            @click="restore(s)"
          >
            <ArchiveRestore :size="14" />
            {{ t("sessionArchive.restore") }}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            class="h-auto gap-1.5 px-2 py-1.5 text-xs text-destructive hover:text-destructive"
            :disabled="!!busy"
            :title="t('sessionArchive.delete')"
            @click="remove(s)"
          >
            <RefreshCw v-if="busy === s.file" :size="14" class="animate-spin" />
            <Trash2 v-else :size="14" />
            {{ t("sessionArchive.delete") }}
          </Button>
        </div>
      </li>
    </ul>
  </section>
</template>
