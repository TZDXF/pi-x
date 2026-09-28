<script setup lang="ts">
import { computed, useId } from "vue"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useI18n } from "vue-i18n"
import { compatFlags, parseModelAdvanced } from "@/lib/modelAdvanced"
const model = defineModel<string>({ required: true })
defineProps<{ api: string }>()
const { t } = useI18n()
const id = useId()
const parsed = computed(() => {
  try {
    return { value: parseModelAdvanced(model.value), error: "" }
  } catch (error) {
    return { value: null, error: String(error) }
  }
})
function compatValue(key: string): string {
  const compat = parsed.value.value?.compat as Record<string, unknown> | undefined
  return compat?.[key] === undefined ? "auto" : String(compat[key])
}
function setCompat(key: string, selected: unknown) {
  if (typeof selected !== "string") return
  if (!parsed.value.value) return
  const value = { ...parsed.value.value }
  const compat = { ...(value.compat as Record<string, unknown> | undefined) }
  if (selected === "auto") delete compat[key]
  else compat[key] = selected === "true" ? true : selected === "false" ? false : selected
  if (Object.keys(compat).length) value.compat = compat
  else delete value.compat
  model.value = JSON.stringify(value, null, 2)
}
</script>

<template>
  <details class="border-border rounded-md border p-3">
    <summary class="cursor-pointer text-xs font-medium">{{ t("settings.modelAdvanced") }}</summary>
    <div class="mt-3 space-y-3 text-xs">
      <template v-if="api === 'openai-completions'">
        <div
          v-for="key in [...compatFlags, 'maxTokensField']"
          :key="key"
          class="flex flex-wrap items-start justify-between gap-3"
        >
          <div class="min-w-0 flex-1 space-y-1">
            <label :for="id + '-' + key" class="break-all font-mono">{{ key }}</label>
            <p :id="id + '-' + key + '-hint'" class="text-muted-foreground leading-relaxed">
              {{ t("settings.modelCompatDescriptions." + key) }}
            </p>
          </div>
          <Select
            :model-value="compatValue(key)"
            :disabled="!!parsed.error"
            @update:model-value="setCompat(key, $event)"
          >
            <SelectTrigger
              :id="id + '-' + key"
              :aria-describedby="id + '-' + key + '-hint'"
              class="h-8 shrink-0 text-xs"
              :class="key === 'maxTokensField' ? 'w-52' : 'w-40'"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{{ t("settings.modelCompatAuto") }}</SelectItem>
              <template v-if="key === 'maxTokensField'">
                <SelectItem value="max_tokens">max_tokens</SelectItem>
                <SelectItem value="max_completion_tokens">max_completion_tokens</SelectItem>
              </template>
              <template v-else>
                <SelectItem value="true">{{ t("settings.modelCompatTrue") }}</SelectItem>
                <SelectItem value="false">{{ t("settings.modelCompatFalse") }}</SelectItem>
              </template>
            </SelectContent>
          </Select>
        </div>
      </template>
      <label class="block space-y-1">
        <span>{{ t("settings.modelAdvancedJson") }}</span>
        <span class="text-muted-foreground block leading-relaxed">{{ t("settings.modelAdvancedJsonHint") }}</span>
        <textarea
          v-model="model"
          rows="9"
          spellcheck="false"
          :aria-invalid="!!parsed.error"
          class="bg-background border-border w-full rounded-md border p-2 font-mono text-xs"
        />
      </label>
      <p v-if="parsed.error" role="alert" class="text-destructive break-all">{{ parsed.error }}</p>
    </div>
  </details>
</template>
