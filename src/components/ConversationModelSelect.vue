<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { groupModelsByProvider } from "@/lib/modelSelection"
import ModelSelectOptions from "@/components/ModelSelectOptions.vue"
import { Select, SelectContent, SelectTrigger, SelectValue } from "@/components/ui/select"

const props = withDefaults(
  defineProps<{
    modelValue: string
    models: { provider: string; id: string; name?: string }[]
    disabled?: boolean
    id?: string
    triggerClass?: string
    openAbove?: boolean
    showProvider?: boolean
  }>(),
  { triggerClass: "h-8 w-auto min-w-0 max-w-64 text-xs", showProvider: true },
)
const emit = defineEmits<{ "update:modelValue": [value: string] }>()
const { t } = useI18n()
const selectedModel = computed(() => props.models.find(model => `${model.provider}/${model.id}` === props.modelValue))
const groups = computed(() => groupModelsByProvider(props.models))
</script>

<template>
  <Select
    :model-value="modelValue"
    :disabled="disabled"
    @update:model-value="
      value => {
        if (typeof value === 'string') emit('update:modelValue', value)
      }
    "
  >
    <SelectTrigger :id="id" :class="triggerClass">
      <SelectValue :placeholder="t('chat.selectModel')">
        {{
          selectedModel
            ? showProvider
              ? `${selectedModel.provider} / ${selectedModel.name || selectedModel.id}`
              : selectedModel.name || selectedModel.id
            : t("chat.selectModel")
        }}
      </SelectValue>
    </SelectTrigger>
    <SelectContent
      :position="openAbove ? 'popper' : 'item-aligned'"
      :side="openAbove ? 'top' : undefined"
      :align="openAbove ? 'start' : 'center'"
      :side-offset="openAbove ? 0 : undefined"
      :side-flip="openAbove ? false : undefined"
    >
      <ModelSelectOptions :groups="groups" />
    </SelectContent>
  </Select>
</template>
