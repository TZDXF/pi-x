<script setup lang="ts">
/** Per-package resource management: enable/disable individual resources. */
import { ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { Spinner } from "@/components/ui/spinner"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import { DialogHeader, DialogTitle, DialogDescription, Dialog, DialogContent } from "@/components/ui/dialog"
import {
  packageResources,
  packageSetResource,
  packageNameOf,
  type InstalledPackage,
  type PackageResource,
} from "@/api/piClient"
import { useUiStore } from "@/stores/conversations"

const props = defineProps<{
  /** Package being managed (null = dialog closed). */
  pkg: InstalledPackage | null
  /** Project path for project-scoped packages. */
  project: string
}>()
const emit = defineEmits<{ close: [] }>()

const ui = useUiStore()
const { t } = useI18n()

const resources = ref<PackageResource[]>([])
const loading = ref(false)
const resourceBusy = ref<string | null>(null)

const RESOURCE_GROUPS: PackageResource["resourceType"][] = ["extensions", "skills", "prompts", "themes"]

watch(
  () => props.pkg,
  async p => {
    if (!p) return
    resources.value = []
    loading.value = true
    try {
      resources.value = await packageResources(p.source, p.scope, props.project)
    } catch (e) {
      ui.pushToast(String(e), "error")
      emit("close")
    } finally {
      loading.value = false
    }
  },
)

function resourcesOf(type: PackageResource["resourceType"]): PackageResource[] {
  return resources.value.filter(r => r.resourceType === type)
}

async function toggleResource(r: PackageResource) {
  if (!props.pkg || resourceBusy.value) return
  const key = `${r.resourceType}:${r.path}`
  resourceBusy.value = key
  try {
    await packageSetResource(props.pkg.source, props.pkg.scope, r.resourceType, r.path, !r.enabled, props.project)
    r.enabled = !r.enabled
  } catch (e) {
    ui.pushToast(String(e), "error")
  } finally {
    resourceBusy.value = null
  }
}

const resourceTypeName = (type: string) => {
  const key = `packages.types.${type.replace(/s$/, "")}`
  const label = t(key)
  return label === key ? type : label
}
</script>

<template>
  <Dialog
    :open="!!pkg"
    @update:open="
      (v: boolean) => {
        if (!v) emit('close')
      }
    "
  >
    <DialogContent v-if="pkg" class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ t("packages.resourcesTitle", { name: packageNameOf(pkg.source) }) }}</DialogTitle>
        <DialogDescription>{{ t("packages.resourcesHint") }}</DialogDescription>
      </DialogHeader>
      <div v-if="loading" class="flex items-center justify-center gap-2 py-8">
        <Spinner class="size-4" />
        <span class="text-muted-foreground text-sm">{{ t("packages.loading") }}</span>
      </div>
      <ScrollArea v-else viewport-class="max-h-[55dvh]">
        <div class="flex flex-col gap-4 pr-2">
          <template v-for="group in RESOURCE_GROUPS" :key="group">
            <div v-if="resourcesOf(group).length">
              <h4 class="mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {{ resourceTypeName(group) }}
              </h4>
              <div
                v-for="r in resourcesOf(group)"
                :key="`${r.resourceType}:${r.path}`"
                class="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-muted/50"
              >
                <Checkbox
                  :model-value="r.enabled"
                  :disabled="resourceBusy !== null"
                  @update:model-value="() => toggleResource(r)"
                />
                <span
                  class="flex-1 truncate font-mono text-xs"
                  :class="r.enabled ? '' : 'text-muted-foreground line-through'"
                  :title="r.path"
                  >{{ r.path }}</span
                >
                <Spinner v-if="resourceBusy === `${r.resourceType}:${r.path}`" class="size-3" />
              </div>
            </div>
          </template>
          <p v-if="!resources.length" class="text-muted-foreground py-6 text-center text-sm">
            {{ t("packages.resourcesEmpty") }}
          </p>
        </div>
      </ScrollArea>
    </DialogContent>
  </Dialog>
</template>
