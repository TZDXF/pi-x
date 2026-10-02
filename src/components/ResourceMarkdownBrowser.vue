<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useUiStore } from "@/stores/conversations"
import { isMarkdownExt } from "@/lib/fileKind"
import { normalizeSlashes } from "@/lib/paths"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import ProjectFiles from "@/components/ProjectFiles.vue"
import ResourceMarkdownPreview from "@/components/ResourceMarkdownPreview.vue"

const props = withDefaults(
  defineProps<{
    listFiles?: () => Promise<string[]>
    readFile?: (path: string) => Promise<string>
    project?: string
    defaultSelectedPath?: string
    emptyText: string
    listClass?: string
  }>(),
  { project: "", listClass: "w-64" },
)
const { t } = useI18n()
const ui = useUiStore()
const files = ref<string[]>([])
const loading = ref(false)
const selected = ref<string | null>(null)
const filter = ref("")
const generation = ref(0)
const hasMatches = computed(() =>
  files.value.some(path => path.toLowerCase().includes(normalizeSlashes(filter.value.trim()).toLowerCase())),
)

watch(
  () => [props.listFiles, props.readFile, props.project] as const,
  async ([listFiles]) => {
    const current = ++generation.value
    files.value = []
    selected.value = null
    filter.value = ""
    loading.value = false
    if (!listFiles) return
    loading.value = true
    try {
      const paths = await listFiles()
      if (current === generation.value) files.value = paths.filter(isMarkdownExt).map(normalizeSlashes)
    } catch (error) {
      if (current === generation.value) ui.pushToast(String(error), "error")
    } finally {
      if (current === generation.value) loading.value = false
    }
  },
  { immediate: true, flush: "sync" },
)
onScopeDispose(() => ++generation.value)
</script>

<template>
  <div data-resource-markdown-browser class="flex min-h-0 flex-1 gap-3 overflow-hidden">
    <div v-if="loading" class="flex flex-1 items-center justify-center">
      <Spinner class="size-4" />
    </div>
    <div v-else-if="!files.length" class="text-muted-foreground flex flex-1 items-center justify-center text-sm">
      {{ emptyText }}
    </div>
    <template v-else>
      <div class="flex min-h-0 shrink-0 flex-col overflow-hidden rounded-md border" :class="listClass">
        <div class="shrink-0 border-b p-1.5">
          <Input
            v-model="filter"
            :placeholder="t('packages.filterFiles')"
            class="h-7 px-2 font-mono text-xs md:text-xs"
          />
        </div>
        <ProjectFiles
          v-show="hasMatches"
          v-model:selected-path="selected"
          data-package-resource-files
          :project="project"
          :files="files"
          :filter="filter"
          :default-selected-path="defaultSelectedPath"
          :preview="false"
          :show-header="false"
        />
        <p v-if="!hasMatches" class="text-muted-foreground py-3 text-center text-xs">
          {{ t("packages.noMatchingFiles") }}
        </p>
      </div>
      <!-- Remount on file or resource changes: pending reads belong only to the old preview. -->
      <ResourceMarkdownPreview
        v-if="selected && readFile"
        :key="JSON.stringify([generation, selected])"
        data-package-resource-preview
        class="overflow-hidden rounded-md border"
        :project="project"
        :path="selected"
        :read-file="readFile"
      />
    </template>
  </div>
</template>
