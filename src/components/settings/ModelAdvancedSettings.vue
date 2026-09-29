<script setup lang="ts">
import { computed, useId } from "vue"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { useI18n } from "vue-i18n"
import { ALL_THINKING_LEVELS } from "@/lib/thinkingLevels"
import type { ThinkingLevel } from "@/api/protocol"
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

const THINKING_INHERIT = "__inherit__"
const THINKING_DEFAULT = "__default__"
const THINKING_DISABLED = "__disabled__"
const THINKING_CUSTOM = "__custom__"
const thinkingLevels = ALL_THINKING_LEVELS

function thinkingMap(): Record<string, unknown> {
  const map = parsed.value.value?.thinkingLevelMap
  return map && typeof map === "object" && !Array.isArray(map) ? (map as Record<string, unknown>) : {}
}
function thinkingMode(level: ThinkingLevel): string {
  const mapped = thinkingMap()[level]
  if (mapped === null) return THINKING_DISABLED
  if (typeof mapped !== "string") return THINKING_INHERIT
  return mapped === level ? THINKING_DEFAULT : THINKING_CUSTOM
}
function thinkingMapping(level: ThinkingLevel): string {
  const mapped = thinkingMap()[level]
  return typeof mapped === "string" ? mapped : level
}
function setThinkingLevel(level: ThinkingLevel, mapped: string | null | undefined) {
  if (!parsed.value.value) return
  const value = { ...parsed.value.value }
  const map = { ...(value.thinkingLevelMap as Record<string, unknown> | undefined) }
  if (mapped === undefined) delete map[level]
  else map[level] = mapped
  if (Object.keys(map).length) value.thinkingLevelMap = map
  else delete value.thinkingLevelMap
  model.value = JSON.stringify(value, null, 2)
}
function setThinkingMode(level: ThinkingLevel, selected: unknown) {
  if (typeof selected !== "string" || !parsed.value.value) return
  if (selected === THINKING_INHERIT) setThinkingLevel(level, undefined)
  else if (selected === THINKING_DISABLED) setThinkingLevel(level, null)
  else setThinkingLevel(level, thinkingMapping(level))
}
function setThinkingMapping(level: ThinkingLevel, value: unknown) {
  if (typeof value !== "string") return
  setThinkingLevel(level, value)
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
      <div class="border-border space-y-2 rounded-md border p-2">
        <div class="space-y-1">
          <span class="font-medium">{{ t("settings.modelThinkingLevels") }}</span>
          <p class="text-muted-foreground leading-relaxed">{{ t("settings.modelThinkingLevelsHint") }}</p>
        </div>
        <div class="grid gap-2 xl:grid-cols-2">
          <div v-for="level in thinkingLevels" :key="level" class="space-y-1">
            <label :for="id + '-thinking-' + level" class="flex items-center justify-between gap-2">
              <span>{{ t("chat.thinkingLevels." + level) }}</span>
              <code class="font-mono">{{ level }}</code>
            </label>
            <Select
              :model-value="thinkingMode(level)"
              :disabled="!!parsed.error"
              @update:model-value="setThinkingMode(level, $event)"
            >
              <SelectTrigger :id="id + '-thinking-' + level" class="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem :value="THINKING_INHERIT">{{ t("settings.modelThinkingInherit") }}</SelectItem>
                <SelectItem v-if="level !== 'off'" :value="THINKING_DEFAULT">
                  {{ t("settings.modelThinkingDefault") }}
                </SelectItem>
                <SelectItem :value="THINKING_DISABLED">{{ t("settings.modelThinkingDisabled") }}</SelectItem>
                <SelectItem :value="THINKING_CUSTOM">{{ t("settings.modelThinkingCustom") }}</SelectItem>
              </SelectContent>
            </Select>
            <Input
              v-if="thinkingMode(level) === THINKING_CUSTOM"
              :id="id + '-thinking-' + level + '-map'"
              :model-value="thinkingMapping(level)"
              :placeholder="level"
              :aria-label="t('settings.modelThinkingMappingLabel') + ' - ' + level"
              class="h-8 font-mono text-xs"
              @update:model-value="setThinkingMapping(level, $event)"
            />
          </div>
        </div>
      </div>
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
