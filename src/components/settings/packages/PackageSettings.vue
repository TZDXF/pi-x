<script setup lang="ts">
/** Pi package management: browse the official pi.dev/packages catalog and
 *  install / remove / update packages via the pi CLI. Mounted by the
 *  #/settings/packages route and remounted on every visit. */
import { onMounted } from "vue"
import { useI18n } from "vue-i18n"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { RefreshCw } from "@lucide/vue"
import { packageSettingsTab } from "./selectedResourcePackage"
import { usePackages } from "./usePackages"
import PackageMarketTab from "./PackageMarketTab.vue"
import PackageInstalledTab from "./PackageInstalledTab.vue"
import BuiltinPackagesTab from "./BuiltinPackagesTab.vue"
import PackageInstallDialog from "./PackageInstallDialog.vue"

const props = defineProps<{ project?: string }>()
const { t } = useI18n()

const innerTab = packageSettingsTab
const ctx = usePackages(() => props.project)

const { installed, catalogLoading, installedLoading, builtinLoading, pendingProjectSource, recentProjects, busy } = ctx
const { activate, loadCatalog, loadBuiltinPlugins, refreshInstalled, confirmProjectInstall } = ctx

function refreshActiveTab() {
  if (innerTab.value === "market") return loadCatalog()
  if (innerTab.value === "builtin") return loadBuiltinPlugins()
  return refreshInstalled()
}

onMounted(activate)
</script>

<template>
  <Tabs v-model="innerTab" class="min-h-0">
    <div class="mb-3 flex items-center justify-between gap-2">
      <TabsList>
        <TabsTrigger value="market">{{ t("packages.market") }}</TabsTrigger>
        <TabsTrigger value="builtin">{{ t("packages.builtinTab") }}</TabsTrigger>
        <TabsTrigger value="installed">
          {{ t("packages.installed") }}
          <span v-if="installed.length" class="text-muted-foreground">({{ installed.length }})</span>
        </TabsTrigger>
      </TabsList>
      <Button
        variant="ghost"
        size="sm"
        :disabled="busy !== null || catalogLoading || installedLoading || builtinLoading"
        @click="refreshActiveTab"
      >
        <RefreshCw :size="14" :class="{ 'animate-spin': catalogLoading || installedLoading || builtinLoading }" />
        {{ t("packages.refresh") }}
      </Button>
    </div>

    <TabsContent value="market" class="mt-0">
      <PackageMarketTab :ctx />
    </TabsContent>

    <TabsContent value="builtin" class="mt-0">
      <BuiltinPackagesTab :ctx />
    </TabsContent>

    <TabsContent value="installed" class="mt-0">
      <PackageInstalledTab :ctx />
    </TabsContent>
  </Tabs>

  <PackageInstallDialog
    :source="pendingProjectSource"
    :recent-projects="recentProjects"
    :busy="busy !== null"
    @confirm="confirmProjectInstall"
    @cancel="pendingProjectSource = ''"
  />
</template>
<style scoped>
.recent-projects {
  padding-top: 12px;
  max-height: 180px;
  overflow-y: auto;
}
</style>
