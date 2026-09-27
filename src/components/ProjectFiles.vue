<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { ChevronRight, File, Folder, FolderOpen, RefreshCw } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { invoke } from "@/api/transport"
import ProjectFilePreview from "@/components/ProjectFilePreview.vue"

interface Entry { name: string; path: string; is_dir: boolean }
const props = defineProps<{ project: string }>()
const { t } = useI18n()
const children = ref<Record<string, Entry[]>>({})
const expanded = ref(new Set<string>())
const loading = ref(new Set<string>())
const errors = ref<Record<string, string>>({})
const selected = ref<string | null>(null)
let generation = 0

async function load(path: string) {
  if (loading.value.has(path)) return
  loading.value = new Set([...loading.value, path])
  const current = generation
  try {
    const entries = await invoke<Entry[]>("list_project_directory", { project: props.project, path })
    if (current === generation) {
      children.value = { ...children.value, [path]: entries }
      const next = { ...errors.value }
      delete next[path]
      errors.value = next
    }
  } catch (error) {
    if (current === generation) errors.value = { ...errors.value, [path]: String(error) }
  } finally {
    if (current === generation) {
      const next = new Set(loading.value)
      next.delete(path)
      loading.value = next
    }
  }
}
function reset() {
  generation++
  children.value = {}
  expanded.value = new Set()
  loading.value = new Set()
  errors.value = {}
  selected.value = null
  void load("")
}
onMounted(reset)
watch(() => props.project, reset)
function toggle(entry: Entry) {
  if (!entry.is_dir) {
    selected.value = entry.path
    return
  }
  const next = new Set(expanded.value)
  if (next.has(entry.path)) next.delete(entry.path)
  else {
    next.add(entry.path)
    if (!(entry.path in children.value)) void load(entry.path)
  }
  expanded.value = next
}
const rows = computed(() => {
  const result: { entry: Entry; depth: number }[] = []
  function append(path: string, depth: number) {
    for (const entry of children.value[path] ?? []) {
      result.push({ entry, depth })
      if (entry.is_dir && expanded.value.has(entry.path)) append(entry.path, depth + 1)
    }
  }
  append("", 0)
  return result
})
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex h-10 shrink-0 items-center justify-between border-b px-3">
      <span class="truncate text-xs text-muted-foreground" :title="project">{{ project.split(/[\\/]/).filter(Boolean).pop() }}</span>
      <Button variant="ghost" size="icon-xs" :title="t('projectFiles.refresh')" :aria-label="t('projectFiles.refresh')" @click="reset"><RefreshCw /></Button>
    </div>
    <div class="grid min-h-0 flex-1 overflow-hidden" :class="selected ? 'grid-cols-[minmax(0,2fr)_minmax(0,3fr)]' : 'grid-cols-1'">
      <ScrollArea class="min-h-0 min-w-0" viewport-class="py-1">
        <p v-if="errors['']" class="px-3 py-2 text-xs text-destructive" role="alert">{{ errors[''] }}</p>
        <p v-else-if="loading.has('')" class="px-3 py-2 text-xs text-muted-foreground">{{ t('completion.loading') }}</p>
        <p v-else-if="!rows.length" class="px-3 py-2 text-xs text-muted-foreground">{{ t('projectFiles.empty') }}</p>
        <template v-for="{ entry, depth } in rows" :key="entry.path">
          <button type="button" class="flex w-full items-center gap-1.5 py-1 pr-2 text-left font-mono text-xs hover:bg-accent/60 focus-visible:outline-ring" :class="{ 'bg-accent': entry.path === selected }" :style="{ paddingLeft: `${8 + depth * 16}px` }" :title="entry.path" @click="toggle(entry)">
            <ChevronRight v-if="entry.is_dir" class="size-3.5 shrink-0" :class="{ 'rotate-90': expanded.has(entry.path) }" />
            <span v-else class="w-3.5 shrink-0" />
            <FolderOpen v-if="entry.is_dir && expanded.has(entry.path)" class="size-3.5 shrink-0" />
            <Folder v-else-if="entry.is_dir" class="size-3.5 shrink-0" />
            <File v-else class="size-3.5 shrink-0" />
            <span class="truncate">{{ entry.name }}</span>
          </button>
          <p v-if="errors[entry.path]" class="px-3 py-1 text-xs text-destructive" role="alert">{{ errors[entry.path] }}</p>
          <p v-else-if="entry.is_dir && expanded.has(entry.path) && loading.has(entry.path)" class="px-3 py-1 text-xs text-muted-foreground">{{ t('completion.loading') }}</p>
        </template>
      </ScrollArea>
      <ProjectFilePreview v-if="selected" :project="project" :path="selected" @close="selected = null" />
    </div>
  </div>
</template>
