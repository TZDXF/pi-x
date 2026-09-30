<script setup lang="ts">
/** Standalone package file browser: left file list, right content preview.
 *  Lists every file in the package (like the project file preview). */
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { navigate } from "@/lib/router"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { packageListFiles, packageReadFile, packageTranslate, packageNameOf } from "@/api/piClient"
import { useUiStore } from "@/stores/conversations"
import { selectedResourcePackage, selectedResourceProject } from "./selectedResourcePackage"
import { Languages, ArrowLeft, FileText } from "@lucide/vue"

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

const visible = computed(() =>
  filter.value.trim() ? files.value.filter(f => f.toLowerCase().includes(filter.value.trim().toLowerCase())) : files.value,
)

const targetLang = computed(() => (locale.value === "zh-CN" ? "Simplified Chinese" : "English"))

watch(
  () => selectedResourcePackage.value,
  async pkg => {
    files.value = []
    selected.value = ""
    content.value = ""
    translated.value = ""
    if (!pkg) return
    loading.value = true
    try {
      files.value = await packageListFiles(
        pkg.source,
        pkg.scope,
        pkg.scope === "project" ? selectedResourceProject.value : undefined,
      )
    } catch (e) {
      ui.pushToast(String(e), "error")
    } finally {
      loading.value = false
    }
    if (files.value.length) select(files.value[0]!)
  },
  { immediate: true },
)

async function select(path: string) {
  selected.value = path
  content.value = ""
  translated.value = ""
  const pkg = selectedResourcePackage.value
  if (!pkg) return
  contentLoading.value = true
  try {
    content.value = await packageReadFile(
      pkg.source,
      pkg.scope,
      path,
      pkg.scope === "project" ? selectedResourceProject.value : undefined,
    )
  } catch (e) {
    ui.pushToast(String(e), "error")
  } finally {
    contentLoading.value = false
  }
}

async function translate() {
  if (!content.value.trim() || translating.value) return
  translating.value = true
  translated.value = ""
  try {
    translated.value = await packageTranslate(content.value, targetLang.value)
  } catch (e) {
    ui.pushToast(String(e), "error")
  } finally {
    translating.value = false
  }
}

function goBack() {
  navigate("/settings/packages")
}

const pkgName = computed(() => (selectedResourcePackage.value ? packageNameOf(selectedResourcePackage.value.source) : ""))
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
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

    <div v-else class="flex min-h-0 flex-1 gap-3">
      <!-- Left: full file list with filter -->
      <div class="flex w-64 shrink-0 flex-col rounded-md border">
        <div class="border-b p-1.5">
          <input
            v-model="filter"
            :placeholder="t('packages.filterFiles')"
            class="h-7 w-full rounded border bg-transparent px-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
          />
        </div>
        <ScrollArea viewport-class="max-h-[calc(100dvh-250px)]">
          <div class="flex flex-col gap-0.5 p-1.5">
            <button
              v-for="f in visible"
              :key="f"
              class="flex items-center gap-1.5 truncate rounded px-1.5 py-1 text-left font-mono text-xs hover:bg-muted"
              :class="selected === f ? 'bg-muted font-medium' : 'text-foreground/80'"
              :title="f"
              @click="select(f)"
            >
              <FileText :size="12" class="text-muted-foreground shrink-0" />
              <span class="truncate">{{ f }}</span>
            </button>
            <p v-if="!visible.length" class="text-muted-foreground py-3 text-center text-xs">
              {{ t("packages.noMatchingFiles") }}
            </p>
          </div>
        </ScrollArea>
      </div>

      <!-- Right: content preview -->
      <div class="flex min-w-0 flex-1 flex-col rounded-md border">
        <div class="flex shrink-0 items-center justify-between border-b px-3 py-1.5">
          <span class="truncate font-mono text-xs text-muted-foreground">{{ selected }}</span>
          <Button variant="ghost" size="sm" :disabled="translating || contentLoading || !content.trim()" @click="translate">
            <Spinner v-if="translating" class="size-3" />
            <Languages v-else :size="14" />
            {{ t("packages.translate") }}
          </Button>
        </div>
        <ScrollArea viewport-class="max-h-[calc(100dvh-260px)]">
          <div class="p-3">
            <div v-if="contentLoading" class="flex items-center gap-2 py-6">
              <Spinner class="size-3" />
              <span class="text-muted-foreground text-xs">{{ t("packages.loadingResource") }}</span>
            </div>
            <pre v-else class="whitespace-pre-wrap font-mono text-xs leading-relaxed">{{ content }}</pre>
            <template v-if="translated">
              <div class="my-3 border-t" />
              <pre class="whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted-foreground">{{ translated }}</pre>
            </template>
          </div>
        </ScrollArea>
      </div>
    </div>
  </div>
</template>
