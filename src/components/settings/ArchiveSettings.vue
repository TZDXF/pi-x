<script setup lang="ts">
/** Archived sessions page: grouped by project, with search, restore and delete actions. */
import { computed, onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { Archive, ArchiveRestore, Folder, RefreshCw, RotateCw, Search, Trash2, X } from "@lucide/vue"
import { deleteSession, listArchivedSessions, type SessionMeta } from "@/api/piClient"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useUiStore } from "@/stores/conversations"
import { useWorkspaceStore } from "@/stores/workspace"

const { t } = useI18n()
const ui = useUiStore()
const workspace = useWorkspaceStore()

const sessions = ref<SessionMeta[]>([])
const loading = ref(false)
const busy = ref<string | null>(null) // file currently being restored/deleted
const pendingDelete = ref<SessionMeta | null>(null) // session awaiting delete confirmation
const error = ref("")
const query = ref("")

const projectName = (path: string) => workspace.projectName(path)
const label = (s: SessionMeta) => s.title || s.preview || t("sidebar.untitled")
const when = (s: SessionMeta) => new Date(s.mtimeMs).toLocaleString()

/** Search matches the session title/preview and the project path or name. */
function matches(s: SessionMeta, q: string) {
  const haystack = `${s.title ?? ""}\n${s.preview ?? ""}\n${s.cwd}`.toLowerCase()
  return haystack.includes(q)
}

interface ArchiveGroup {
  cwd: string
  name: string
  rows: SessionMeta[]
}
const groups = computed<ArchiveGroup[]>(() => {
  const q = query.value.trim().toLowerCase()
  const byProject = new Map<string, SessionMeta[]>()
  for (const s of sessions.value) {
    if (q && !matches(s, q)) continue
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

/** Open the in-app confirm dialog; the native/system dialog is avoided on purpose. */
function askRemove(s: SessionMeta) {
  if (busy.value) return
  pendingDelete.value = s
}

async function remove(s: SessionMeta) {
  pendingDelete.value = null
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
  <div class="flex items-center gap-3">
    <label
      class="flex h-8 flex-1 items-center gap-2 rounded-md border border-border bg-background px-2.5 text-muted-foreground focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/30"
    >
      <Search :size="14" class="shrink-0" />
      <input
        v-model="query"
        type="search"
        :placeholder="t('sessionArchive.search')"
        :aria-label="t('sessionArchive.search')"
        class="h-full min-w-0 flex-1 appearance-none bg-transparent px-0 py-0 text-xs outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
      />
      <button
        v-if="query"
        type="button"
        class="shrink-0 rounded p-0.5 hover:bg-muted hover:text-foreground"
        :aria-label="t('common.clear')"
        @click="query = ''"
      >
        <X :size="13" />
      </button>
    </label>
    <Button variant="outline" size="sm" class="h-8 shrink-0 gap-2 px-3 text-xs" :disabled="loading" @click="load">
      <RotateCw :size="14" :class="{ 'animate-spin': loading }" />
      {{ t("sessionArchive.refresh") }}
    </Button>
  </div>

  <p class="text-xs text-muted-foreground">
    {{ t("sessionArchive.count", { count: sessions.length }) }}
  </p>

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
  <p v-else-if="!sessions.length" class="flex items-center gap-2 py-8 text-sm text-muted-foreground">
    <Archive :size="16" />
    {{ t("sessionArchive.empty") }}
  </p>
  <p v-else-if="!groups.length" class="flex items-center gap-2 py-8 text-sm text-muted-foreground">
    <Search :size="16" />
    {{ t("sessionArchive.noMatch") }}
  </p>

  <div class="space-y-4">
    <section v-for="group in groups" :key="group.cwd" class="overflow-hidden rounded-lg border border-border/60">
      <header class="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-3 py-2">
        <Folder :size="15" class="shrink-0 text-muted-foreground" />
        <h3 class="truncate text-sm font-medium" :title="group.cwd">{{ group.name }}</h3>
        <span class="ml-auto shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
          {{ group.rows.length }}
        </span>
      </header>
      <ul class="divide-y divide-border/60">
        <li
          v-for="s in group.rows"
          :key="s.file"
          class="group flex items-center gap-2 px-3 py-2 transition-colors hover:bg-muted/40"
        >
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm" :title="label(s)">{{ label(s) }}</p>
            <p class="text-xs text-muted-foreground">{{ when(s) }}</p>
          </div>
          <div class="flex shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              class="text-muted-foreground hover:text-foreground"
              :disabled="!!busy"
              :title="t('sessionArchive.restore')"
              :aria-label="t('sessionArchive.restore')"
              @click="restore(s)"
            >
              <RefreshCw v-if="busy === s.file" :size="14" class="animate-spin" />
              <ArchiveRestore v-else :size="15" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              class="text-muted-foreground hover:text-destructive"
              :disabled="!!busy"
              :title="t('sessionArchive.delete')"
              :aria-label="t('sessionArchive.delete')"
              @click="askRemove(s)"
            >
              <Trash2 :size="15" />
            </Button>
          </div>
        </li>
      </ul>
    </section>
  </div>
  <Dialog
    :open="!!pendingDelete"
    @update:open="
      (v: boolean) => {
        if (!v && !busy) pendingDelete = null
      }
    "
  >
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{{ t("sessionArchive.delete") }}</DialogTitle>
        <DialogDescription>
          {{ pendingDelete ? t("sessionArchive.deleteConfirm", { name: label(pendingDelete) }) : "" }}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" :disabled="!!busy" @click="pendingDelete = null">
          {{ t("common.cancel") }}
        </Button>
        <Button variant="destructive" :disabled="!!busy" @click="pendingDelete && remove(pendingDelete)">
          {{ t("sessionArchive.delete") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
