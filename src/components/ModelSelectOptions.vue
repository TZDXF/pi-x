<script setup lang="ts">
import type { SelectableModel } from "@/lib/modelSelection"
import { SelectGroup, SelectItem, SelectLabel } from "@/components/ui/select"
import { modelKey } from "@/lib/modelKey"

defineProps<{ groups: { provider: string; models: SelectableModel[] }[] }>()
</script>

<template>
  <SelectGroup v-for="group in groups" :key="group.provider">
    <SelectLabel>{{ group.provider }}</SelectLabel>
    <SelectItem v-for="model in group.models" :key="modelKey(model)" :value="modelKey(model)" class="text-xs">
      {{ model.name || model.id }}
    </SelectItem>
  </SelectGroup>
</template>
