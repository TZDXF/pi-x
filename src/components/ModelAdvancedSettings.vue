<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { compatFlags, parseModelAdvanced } from "@/lib/modelAdvanced"
const model = defineModel<string>({ required: true })
defineProps<{ api: string }>()
const { t } = useI18n()
const parsed = computed(() => {
  try { return { value: parseModelAdvanced(model.value), error: "" } }
  catch (error) { return { value: null, error: String(error) } }
})
function compatValue(key: string): string {
  const compat = parsed.value.value?.compat as Record<string, unknown> | undefined
  return compat?.[key] === undefined ? 'auto' : String(compat[key])
}
function setCompat(key: string, event: Event) {
  if (!parsed.value.value) return
  const value = { ...parsed.value.value }
  const compat = { ...(value.compat as Record<string, unknown> | undefined) }
  const selected = (event.target as HTMLSelectElement).value
  if (selected === 'auto') delete compat[key]
  else compat[key] = selected === 'true' ? true : selected === 'false' ? false : selected
  if (Object.keys(compat).length) value.compat = compat
  else delete value.compat
  model.value = JSON.stringify(value, null, 2)
}
</script>

<template>
  <details class="border-border rounded-md border p-3">
    <summary class="cursor-pointer text-xs font-medium">{{ t('settings.modelAdvanced') }}</summary>
    <div class="mt-3 space-y-3 text-xs">
      <p class="text-muted-foreground">{{ t('settings.modelAdvancedHint') }}</p>
      <template v-if="api === 'openai-completions'">
        <p class="text-muted-foreground">{{ t('settings.modelDeveloperHint') }}</p>
        <label v-for="key in compatFlags" :key="key" class="flex flex-wrap items-center justify-between gap-2">
          <span class="font-mono">{{ key }}</span>
          <select :value="compatValue(key)" :disabled="!!parsed.error" class="bg-background border-border rounded border p-1" @change="setCompat(key, $event)">
            <option value="auto">{{ t('settings.modelCompatAuto') }}</option>
            <option value="true">{{ t('settings.modelCompatTrue') }}</option>
            <option value="false">{{ t('settings.modelCompatFalse') }}</option>
          </select>
        </label>
        <label class="flex flex-wrap items-center justify-between gap-2">
          <span class="font-mono">maxTokensField</span>
          <select :value="compatValue('maxTokensField')" :disabled="!!parsed.error" class="bg-background border-border rounded border p-1" @change="setCompat('maxTokensField', $event)">
            <option value="auto">{{ t('settings.modelCompatAuto') }}</option>
            <option value="max_tokens">max_tokens</option>
            <option value="max_completion_tokens">max_completion_tokens</option>
          </select>
        </label>
      </template>
      <label class="block space-y-1">
        <span>{{ t('settings.modelAdvancedJson') }}</span>
        <textarea v-model="model" rows="9" spellcheck="false" :aria-invalid="!!parsed.error" class="bg-background border-border w-full rounded-md border p-2 font-mono text-xs" />
      </label>
      <p v-if="parsed.error" role="alert" class="text-destructive break-all">{{ parsed.error }}</p>
    </div>
  </details>
</template>
