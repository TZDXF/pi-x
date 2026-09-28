<script setup lang="ts">
/** Add/edit panel for one model entry. Rendered inline in the list while
 *  editing, or standalone below the list while adding. */
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { FetchedModel, ProviderEntry } from "@/api/piClient"
import { PROVIDER_API_TYPES } from "@/stores/modelsConfig"
import ModelAdvancedSettings from "@/components/settings/ModelAdvancedSettings.vue"
import ModelFetchPopover from "./ModelFetchPopover.vue"
import type { ModelForm } from "./modelForm"

/** The form object; fields are mutated in place via v-model. */
const form = defineModel<ModelForm | null>({ required: true })

const props = defineProps<{
  /** true while editing an existing entry (id locked, no fetch picker). */
  isEdit: boolean
  provider: ProviderEntry | undefined
  existingIds: Set<string>
  busy: boolean
}>()
const emit = defineEmits<{ save: []; cancel: [] }>()
const { t } = useI18n()

/** reka Select forbids empty item values: "inherit" is mapped to an empty api. */
const API_INHERIT = "__inherit__"
const apiValue = computed({
  get: () => (form.value?.api ? form.value.api : API_INHERIT),
  set: (v: string) => {
    if (form.value) form.value.api = v === API_INHERIT ? "" : v
  },
})

/** Fill the form from a discovered model. */
function pickFetched(m: FetchedModel) {
  if (!form.value) return
  form.value.id = m.id
  form.value.name = m.name ?? ""
}
</script>

<template>
  <div
    v-if="form"
    class="border-border bg-muted/40 space-y-3 p-4"
    :class="props.isEdit ? 'border-t' : 'mt-2 rounded-lg border'"
  >
    <h3 class="text-sm font-medium">{{ props.isEdit ? t("settings.modelEdit") : t("settings.modelAdd") }}</h3>
    <div class="grid grid-cols-2 gap-3">
      <div>
        <label class="mb-1 block text-xs" for="model-id">{{ t("settings.modelId") }}</label>
        <div class="flex items-center gap-1">
          <Input id="model-id" v-model="form.id" class="font-mono text-xs" :disabled="props.isEdit" />
          <ModelFetchPopover
            v-if="!props.isEdit"
            :provider="props.provider"
            :existing-ids="props.existingIds"
            @pick="pickFetched"
          />
        </div>
      </div>
      <div>
        <label class="mb-1 block text-xs" for="model-name">{{ t("settings.modelName") }}</label>
        <Input id="model-name" v-model="form.name" class="text-xs" />
      </div>
    </div>
    <div class="grid grid-cols-3 gap-3">
      <div>
        <label class="mb-1 block text-xs" for="model-api">{{ t("settings.modelApi") }}</label>
        <Select v-model="apiValue">
          <SelectTrigger id="model-api" class="h-8 w-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem :value="API_INHERIT">{{ t("settings.modelApiInherit") }}</SelectItem>
            <SelectItem v-for="api in PROVIDER_API_TYPES" :key="api" :value="api">{{ api }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div>
        <label class="mb-1 block text-xs" for="model-ctx">{{ t("settings.modelContextWindow") }}</label>
        <Input id="model-ctx" v-model="form.contextWindow" placeholder="128000" class="text-xs" />
      </div>
      <div>
        <label class="mb-1 block text-xs" for="model-max">{{ t("settings.modelMaxTokens") }}</label>
        <Input id="model-max" v-model="form.maxTokens" placeholder="16384" class="text-xs" />
      </div>
    </div>
    <div class="flex items-center gap-5 text-xs">
      <label class="flex items-center gap-2">
        <Checkbox v-model="form.reasoning" />
        {{ t("settings.modelReasoning") }}
      </label>
      <label class="flex items-center gap-2">
        <Checkbox v-model="form.image" />
        {{ t("settings.modelImage") }}
      </label>
    </div>

    <ModelAdvancedSettings v-model="form.advanced" :api="form.api || props.provider?.api || ''" />

    <div class="flex justify-end gap-2 pt-1">
      <Button variant="outline" size="sm" type="button" @click="emit('cancel')">
        {{ t("common.cancel") }}
      </Button>
      <Button size="sm" :disabled="props.busy" @click="emit('save')">
        {{ props.busy ? t("settings.saving") : t("settings.save") }}
      </Button>
    </div>
  </div>
</template>
