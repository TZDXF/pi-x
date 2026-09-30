<script setup lang="ts">
/** Package-specific data source for the shared project file list and preview. */
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { Languages, ArrowLeft } from "@lucide/vue"
import { navigate } from "@/lib/router"
import { isMarkdownExt } from "@/lib/fileKind"
import { normalizeSlashes } from "@/lib/paths"
import type { FilePreview } from "@/lib/projectFiles"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import ProjectFiles from "@/components/ProjectFiles.vue"
import ProjectFilePreview from "@/components/ProjectFilePreview.vue"
import { Markdown } from "vue-stream-markdown"
import { markdownLinkOptions } from "@/lib/linkOptions"
import { packageListFiles, packageReadFile, packageTranslate, packageNameOf } from "@/api/piClient"
import { useUiStore } from "@/stores/conversations"
import { packageSettingsTab, selectedResourcePackage, selectedResourceProject } from "./selectedResourcePackage"

const { t, locale } = useI18n()
const ui = useUiStore()
const files = ref<string[]>([])
const loading = ref(false)
const selected = ref<string | null>(null)
const translating = ref(false)
const translated = ref("")
const filter = ref("")
let packageRequest = 0
let translationRequest = 0

const hasMatches = computed(() =>
  files.value.some(path => path.toLowerCase().includes(normalizeSlashes(filter.value.trim()).toLowerCase())),
)
const targetLang = computed(() => (locale.value === "zh-CN" ? "Simplified Chinese" : "English"))
const pkgName = computed(() =>
  selectedResourcePackage.value ? packageNameOf(selectedResourcePackage.value.source) : "",
)
const project = computed(() =>
  selectedResourcePackage.value?.scope === "project" ? selectedResourceProject.value : "",
)

// Capture the package identity so an in-flight read never changes its data source.
const readResourceFile = computed(() => {
  const pkg = selectedResourcePackage.value
  const cwd = project.value
  if (!pkg) return undefined
  return async (path: string): Promise<FilePreview> => ({
    kind: "text",
    text: await packageReadFile(pkg.source, pkg.scope, path, cwd || undefined),
    truncated: false,
    mime: null,
    data: null,
  })
})

watch(
  () => [selectedResourcePackage.value, selected.value, project.value] as const,
  () => {
    ++translationRequest
    translating.value = false
    translated.value = ""
  },
  { flush: "sync" },
)

watch(
  () => [selectedResourcePackage.value, project.value] as const,
  async ([pkg, cwd]) => {
    const request = ++packageRequest
    files.value = []
    selected.value = null
    filter.value = ""
    loading.value = false
    if (!pkg) return
    loading.value = true
    try {
      const allFiles = await packageListFiles(pkg.source, pkg.scope, cwd || undefined)
      if (request === packageRequest) files.value = allFiles.filter(isMarkdownExt).map(normalizeSlashes)
    } catch (e) {
      if (request === packageRequest) ui.pushToast(String(e), "error")
    } finally {
      if (request === packageRequest) loading.value = false
    }
  },
  { immediate: true },
)

function goBack() {
  packageSettingsTab.value = "installed"
  navigate("/settings/packages")
}

async function translate(content: string) {
  if (!content.trim() || translating.value) return
  const request = ++translationRequest
  translating.value = true
  translated.value = ""
  try {
    const text = await packageTranslate(content, targetLang.value)
    if (request === translationRequest) translated.value = text
  } catch (e) {
    if (request === translationRequest) ui.pushToast(String(e), "error")
  } finally {
    if (request === translationRequest) translating.value = false
  }
}
</script>

<template>
  <div data-package-resources class="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    <div class="mb-3 flex shrink-0 items-center gap-2">
      <Button variant="ghost" size="sm" @click="goBack">
        <ArrowLeft :size="14" />
        {{ t("packages.backToPackages") }}
      </Button>
      <span class="text-sm font-medium">{{ t("packages.resourcesPageTitle", { name: pkgName }) }}</span>
    </div>

    <div v-if="loading" class="flex flex-1 items-center justify-center">
      <Spinner class="size-4" />
    </div>
    <div v-else-if="!files.length" class="text-muted-foreground flex flex-1 items-center justify-center text-sm">
      {{ t("packages.resourcesEmpty") }}
    </div>
    <div v-else class="flex min-h-0 flex-1 gap-3 overflow-hidden">
      <div class="flex min-h-0 w-64 shrink-0 flex-col overflow-hidden rounded-md border">
        <div class="shrink-0 border-b p-1.5">
          <input
            v-model="filter"
            :placeholder="t('packages.filterFiles')"
            class="h-7 w-full rounded border bg-transparent px-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
          />
        </div>
        <ProjectFiles
          v-show="hasMatches"
          v-model:selected-path="selected"
          data-package-resource-files
          :project="project"
          :files="files"
          :filter="filter"
          default-selected-path="README.md"
          :preview="false"
          :show-header="false"
        />
        <p v-if="!hasMatches" class="text-muted-foreground py-3 text-center text-xs">
          {{ t("packages.noMatchingFiles") }}
        </p>
      </div>
      <ProjectFilePreview
        v-if="selected"
        data-package-resource-preview
        class="overflow-hidden rounded-md border"
        :project="project"
        :path="selected"
        :read-file="readResourceFile"
        :closable="false"
      >
        <template #toolbar="{ text, loading: contentLoading }">
          <Button
            variant="ghost"
            size="sm"
            :disabled="translating || contentLoading || !text.trim()"
            @click="translate(text)"
          >
            <Spinner v-if="translating" class="size-3" />
            <Languages v-else :size="14" />
            {{ t("packages.translate") }}
          </Button>
        </template>
        <template #after-content>
          <template v-if="translated">
            <div class="my-3 border-t" />
            <Markdown
              :content="translated"
              mode="static"
              :enable-animate="false"
              :link-options="markdownLinkOptions"
              class="text-sm"
            />
          </template>
        </template>
      </ProjectFilePreview>
    </div>
  </div>
</template>
