<script setup lang="ts">
/** Standalone package resource page: left file list, right content preview.
 *  Extensions are managed from the installed list (not shown here). */
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { navigate } from "@/lib/router"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { packageResources, packageReadResource, packageTranslate, packageNameOf } from "@/api/piClient"
import type { PackageResource } from "@/api/piClient"
import { useUiStore } from "@/stores/conversations"
import { selectedResourcePackage, selectedResourceProject } from "./selectedResourcePackage"
import { Languages, ArrowLeft } from "@lucide/vue"

const { t, locale } = useI18n()
const ui = useUiStore()

const resources = ref<PackageResource[]>([])
const loading = ref(false)
const selected = ref<PackageResource | null>(null)
const content = ref("")
const contentLoading = ref(false)
const translating = ref(false)
const translated = ref("")

/** Only non-extension resources are manageable here. */
const visible = computed(() => resources.value.filter(r => r.resourceType !== "extensions"))

const GROUPS: PackageResource["resourceType"][] = ["skills", "prompts", "themes"]

const grouped = computed(() =>
  GROUPS.map(type => ({ type, items: visible.value.filter(r => r.resourceType === type) })).filter(g => g.items.length),
)

const targetLang = computed(() => (locale.value === "zh-CN" ? "Simplified Chinese" : "English"))

watch(
  () => selectedResourcePackage.value,
  async pkg => {
    resources.value = []
    selected.value = null
    content.value = ""
    translated.value = ""
    if (!pkg) return
    loading.value = true
    try {
      resources.value = await packageResources(pkg.source, pkg.scope, pkg.scope === "project" ? selectedResourceProject.value : undefined)
    } catch (e) {
      ui.pushToast(String(e), "error")
    } finally {
      loading.value = false
    }
    // Auto-select the first resource.
    if (visible.value.length) select(visible.value[0]!)
  },
  { immediate: true },
)

async function select(r: PackageResource) {
  selected.value = r
  content.value = ""
  translated.value = ""
  const pkg = selectedResourcePackage.value
  if (!pkg) return
  contentLoading.value = true
  try {
    content.value = await packageReadResource(pkg.source, pkg.scope, r.resourceType, r.path, pkg.scope === "project" ? selectedResourceProject.value : undefined)
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

    <div v-else-if="!visible.length" class="text-muted-foreground flex flex-1 items-center justify-center text-sm">
      {{ t("packages.resourcesEmpty") }}
    </div>

    <div v-else class="flex min-h-0 flex-1 gap-3">
      <!-- Left: file list -->
      <ScrollArea class="w-56 shrink-0 rounded-md border" viewport-class="max-h-[calc(100dvh-220px)]">
        <div class="flex flex-col gap-1 p-1.5">
          <template v-for="g in grouped" :key="g.type">
            <div class="text-muted-foreground px-1.5 pt-2 text-[10px] font-medium uppercase tracking-wide">
              {{ t(`packages.types.${g.type.replace(/s$/, "")}`) }}
            </div>
            <button
              v-for="r in g.items"
              :key="`${r.resourceType}:${r.path}`"
              class="truncate rounded px-1.5 py-1 text-left font-mono text-xs hover:bg-muted"
              :class="selected === r ? 'bg-muted font-medium' : 'text-foreground/80'"
              :title="r.path"
              @click="select(r)"
            >
              {{ r.path }}
            </button>
          </template>
        </div>
      </ScrollArea>

      <!-- Right: content preview -->
      <div class="flex min-w-0 flex-1 flex-col rounded-md border">
        <div class="flex shrink-0 items-center justify-between border-b px-3 py-1.5">
          <span class="truncate font-mono text-xs text-muted-foreground">{{ selected?.path }}</span>
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
