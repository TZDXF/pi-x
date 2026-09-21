<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

const props = withDefaults(defineProps<{
  modelValue: string
  models: { provider: string; id: string; name?: string }[]
  disabled?: boolean
  id?: string
  triggerClass?: string
}>(), { triggerClass: "h-8 w-56 text-xs" })
const emit = defineEmits<{ "update:modelValue": [value: string] }>()
const { t } = useI18n()
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
      <SelectValue :placeholder="t('chat.selectModel')" />
    </SelectTrigger>
    <SelectContent>
      <template v-for="group in groups" :key="group.provider">
        <SelectItem v-for="model in group.models" :key="model.provider + '/' + model.id" :value="model.provider + '/' + model.id" class="text-xs">
          {{ model.provider }} / {{ model.name || model.id }}
        </SelectItem>
      </template>
    </SelectContent>
  </Select>
</template>
