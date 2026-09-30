<script setup lang="ts">
/** Package Markdown browser: directory tree on the left, rendered preview on the right. */
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { navigate } from "@/lib/router"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { FileTree } from "@/components/ai-elements/file-tree"
import { MessageResponse } from "@/components/ai-elements/message"
import { isMarkdownExt } from "@/lib/fileKind"
import { normalizeSlashes } from "@/lib/paths"
import { buildFileTree, flattenVisibleTree } from "@/lib/reviewFileTree"
import PackageResourceTree from "./PackageResourceTree.vue"
import { packageListFiles, packageReadFile, packageTranslate, packageNameOf } from "@/api/piClient"
import { useUiStore } from "@/stores/conversations"
import { selectedResourcePackage, selectedResourceProject } from "./selectedResourcePackage"
import { Languages, ArrowLeft } from "@lucide/vue"

const { t, locale } = useI18n()
const ui = useUiStore()

const files = ref<string[]>([])
const loading = ref(false)
const selected = ref("")
const content = ref("")
const contentLoading = ref(false)
const translating = ref(false)
const translated = ref("")
const filter = ref("")
const expanded = ref(new Set<string>())
let packageRequest = 0
let contentRequest = 0
let translationRequest = 0

const visible = computed(() =>
  filter.value.trim()
    ? files.value.filter(f => f.toLowerCase().includes(filter.value.trim().toLowerCase()))
    : files.value,
)

const tree = computed(() => buildFileTree(visible.value.map(path => ({ path }))))
const directoryPaths = computed(
  () =>
    new Set(
      flattenVisibleTree(tree.value, new Set())
        .filter(row => row.isDir)
        .map(row => row.fullPath),
    ),
)
// Searching reveals matching documents even when their parent directories were collapsed.
const expandedPaths = computed(() => (filter.value.trim() ? directoryPaths.value : expanded.value))

const targetLang = computed(() => (locale.value === "zh-CN" ? "Simplified Chinese" : "English"))

watch(
  () => selectedResourcePackage.value,
  async pkg => {
    const request = ++packageRequest
    ++contentRequest
    ++translationRequest
    contentLoading.value = false
    translating.value = false
    loading.value = false
    filter.value = ""
    expanded.value = new Set()
    files.value = []
    selected.value = ""
    content.value = ""
    translated.value = ""
    if (!pkg) return
    loading.value = true
    try {
      const allFiles = await packageListFiles(
        pkg.source,
        pkg.scope,
        pkg.scope === "project" ? selectedResourceProject.value : undefined,
      )
      if (request !== packageRequest) return
      files.value = allFiles.filter(isMarkdownExt).map(normalizeSlashes)
      expanded.value = directoryPaths.value
      if (files.value.length) void select(files.value[0]!)
    } catch (e) {
      if (request === packageRequest) ui.pushToast(String(e), "error")
    } finally {
      if (request === packageRequest) loading.value = false
    }
  },
  { immediate: true },
)

async function select(path: string) {
  // Folder clicks only toggle the tree; never try to read them as documents.
  if (!files.value.includes(path)) return
  const request = ++contentRequest
  ++translationRequest
  translating.value = false
  selected.value = path
  content.value = ""
  translated.value = ""
  const pkg = selectedResourcePackage.value
  if (!pkg) return
  contentLoading.value = true
  try {
    const text = await packageReadFile(
      pkg.source,
      pkg.scope,
      path,
      pkg.scope === "project" ? selectedResourceProject.value : undefined,
    )
    if (request === contentRequest) content.value = text
  } catch (e) {
    if (request === contentRequest) ui.pushToast(String(e), "error")
  } finally {
    if (request === contentRequest) contentLoading.value = false
  }
}

async function translate() {
  if (!content.value.trim() || translating.value) return
  const request = ++translationRequest
  translating.value = true
  translated.value = ""
  try {
    const text = await packageTranslate(content.value, targetLang.value)
    if (request === translationRequest) translated.value = text
  } catch (e) {
    if (request === translationRequest) ui.pushToast(String(e), "error")
  } finally {
    if (request === translationRequest) translating.value = false
  }
}

function goBack() {
  navigate("/settings/packages")
}

const pkgName = computed(() =>
  selectedResourcePackage.value ? packageNameOf(selectedResourcePackage.value.source) : "",
)
</script>

<template>
  <div data-package-resources class="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
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
      <!-- Left: Markdown directory tree with path filter -->
      <div class="flex min-h-0 w-64 shrink-0 flex-col overflow-hidden rounded-md border">
        <div class="shrink-0 border-b p-1.5">
          <input
            v-model="filter"
            :placeholder="t('packages.filterFiles')"
            class="h-7 w-full rounded border bg-transparent px-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
          />
        </div>
        <ScrollArea data-package-resource-files class="min-h-0 flex-1">
          <FileTree
            v-if="visible.length"
            :selected-path="selected"
            :expanded="expandedPaths"
            class="border-0 text-xs"
            @update:selected-path="select"
            @expanded-change="expanded = $event"
          >
            <PackageResourceTree :nodes="tree" />
          </FileTree>
          <p v-else class="text-muted-foreground py-3 text-center text-xs">
            {{ t("packages.noMatchingFiles") }}
          </p>
        </ScrollArea>
      </div>

      <!-- Right: content preview -->
      <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border">
        <div class="flex shrink-0 items-center justify-between border-b px-3 py-1.5">
          <span class="truncate font-mono text-xs text-muted-foreground">{{ selected }}</span>
          <Button
            variant="ghost"
            size="sm"
            :disabled="translating || contentLoading || !content.trim()"
            @click="translate"
          >
            <Spinner v-if="translating" class="size-3" />
            <Languages v-else :size="14" />
            {{ t("packages.translate") }}
          </Button>
        </div>
        <ScrollArea data-package-resource-preview class="min-h-0 flex-1">
          <div class="p-3">
            <div v-if="contentLoading" class="flex items-center gap-2 py-6">
              <Spinner class="size-3" />
              <span class="text-muted-foreground text-xs">{{ t("packages.loadingResource") }}</span>
            </div>
            <MessageResponse v-else :key="selected" :content="content" class="text-sm" />
            <template v-if="translated">
              <div class="my-3 border-t" />
              <MessageResponse :content="translated" class="text-sm" />
            </template>
          </div>
        </ScrollArea>
      </div>
    </div>
  </div>
</template>
