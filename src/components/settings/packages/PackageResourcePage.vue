<script setup lang="ts">
/** Package-specific data source for the shared Markdown resource browser. */
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { ArrowLeft } from "@lucide/vue"
import { navigate } from "@/lib/router"
import { Button } from "@/components/ui/button"
import ResourceMarkdownBrowser from "@/components/ResourceMarkdownBrowser.vue"
import { packageListFiles, packageReadFile, packageNameOf } from "@/api/piClient"
import { packageSettingsTab, selectedResourcePackage, selectedResourceProject } from "./selectedResourcePackage"

const { t } = useI18n()
const pkgName = computed(() =>
  selectedResourcePackage.value ? packageNameOf(selectedResourcePackage.value.source) : "",
)
const project = computed(() =>
  selectedResourcePackage.value?.scope === "project" ? selectedResourceProject.value : "",
)
const listResourceFiles = computed(() => {
  const pkg = selectedResourcePackage.value
  const cwd = project.value
  if (!pkg) return undefined
  const { source, scope } = pkg
  return () => packageListFiles(source, scope, cwd || undefined)
})
const readResourceFile = computed(() => {
  const pkg = selectedResourcePackage.value
  const cwd = project.value
  if (!pkg) return undefined
  const { source, scope } = pkg
  return (path: string) => packageReadFile(source, scope, path, cwd || undefined)
})

function goBack() {
  packageSettingsTab.value = "installed"
  navigate("/settings/packages")
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
    <ResourceMarkdownBrowser
      :list-files="listResourceFiles"
      :read-file="readResourceFile"
      :project="project"
      :empty-text="t('packages.resourcesEmpty')"
      default-selected-path="README.md"
    />
  </div>
</template>
