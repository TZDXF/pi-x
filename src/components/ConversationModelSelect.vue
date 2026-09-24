<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select"

const props = withDefaults(defineProps<{
  modelValue: string
  models: { provider: string; id: string; name?: string }[]
  disabled?: boolean
  id?: string
  triggerClass?: string
  openAbove?: boolean
}>(), { triggerClass: "h-8 w-auto min-w-0 max-w-64 text-xs" })
const emit = defineEmits<{ "update:modelValue": [value: string] }>()
const { t } = useI18n()
const selectedModel = computed(() => props.models.find(model => `${model.provider}/${model.id}` === props.modelValue))
const groups = computed(() => {
  const grouped = new Map<string, typeof props.models>()
  for (const model of props.models) {
    const list = grouped.get(model.provider) ?? []
    list.push(model)
    grouped.set(model.provider, list)
  }
  return [...grouped.entries()].map(([provider, models]) => ({ provider, models }))
})
</script>

<template>
  <Select :model-value="modelValue" :disabled="disabled" @update:model-value="value => { if (typeof value === 'string') emit('update:modelValue', value) }">
    <SelectTrigger :id="id" :class="triggerClass">
      <SelectValue :placeholder="t('chat.selectModel')">
        {{ selectedModel ? `${selectedModel.provider} / ${selectedModel.name || selectedModel.id}` : t('chat.selectModel') }}
      </SelectValue>
    </SelectTrigger>
    <SelectContent
      :position="openAbove ? 'popper' : 'item-aligned'"
      :side="openAbove ? 'top' : undefined"
      :align="openAbove ? 'start' : 'center'"
      :side-offset="openAbove ? 0 : undefined"
      :side-flip="openAbove ? false : undefined"
    >
      <SelectGroup v-for="group in groups" :key="group.provider">
        <SelectLabel>{{ group.provider }}</SelectLabel>
        <SelectItem v-for="model in group.models" :key="model.provider + '/' + model.id" :value="model.provider + '/' + model.id" class="text-xs">
          {{ model.name || model.id }}
        </SelectItem>
      </SelectGroup>
    </SelectContent>
  </Select>
</template>
