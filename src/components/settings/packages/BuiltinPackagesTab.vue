<script setup lang="ts">
/** Built-in PiX extensions shipped with the desktop app. */
import { useI18n } from "vue-i18n"
import { FileDiff } from "@lucide/vue"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import type { PackagesContext } from "./usePackages"

const props = defineProps<{ ctx: PackagesContext }>()
const { t } = useI18n()
const { builtinLoading, builtinBusy, builtinFileChanges, setBuiltinFileChanges } = props.ctx
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-lg border p-4">
      <div class="flex items-start gap-3">
        <div class="grid size-9 shrink-0 place-items-center rounded-md bg-muted">
          <FileDiff class="size-4" />
        </div>
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="text-sm font-medium">{{ t("packages.builtin.fileChanges.name") }}</h3>
            <Badge variant="secondary">{{ t("packages.builtinBadge") }}</Badge>
          </div>
          <p class="text-muted-foreground mt-1 text-xs leading-relaxed">
            {{ t("packages.builtin.fileChanges.description") }}
          </p>
        </div>
        <div class="flex size-8 shrink-0 items-center justify-center">
          <Spinner v-if="builtinLoading || builtinBusy" class="size-4" />
          <Switch
            v-else
            :model-value="builtinFileChanges"
            :aria-label="t('packages.builtin.fileChanges.name')"
            @update:model-value="v => setBuiltinFileChanges(Boolean(v))"
          />
        </div>
      </div>
    </div>
    <p class="text-muted-foreground text-xs">{{ t("packages.builtinHint") }}</p>
  </div>
</template>
