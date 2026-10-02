<script setup lang="ts">
import type { SelectableModel } from "@/lib/modelSelection"
import { SelectGroup, SelectItem, SelectLabel } from "@/components/ui/select"

defineProps<{ groups: { provider: string; models: SelectableModel[] }[] }>()
</script>

<template>
  <SelectGroup v-for="group in groups" :key="group.provider">
    <SelectLabel>{{ group.provider }}</SelectLabel>
    <SelectItem
      v-for="model in group.models"
      :key="model.provider + '/' + model.id"
      :value="model.provider + '/' + model.id"
      class="text-xs"
    >
      {{ model.name || model.id }}
    </SelectItem>
  </SelectGroup>
</template>
