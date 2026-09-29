<script setup lang="ts">
import { computed, nextTick, ref, useId } from "vue"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Input } from "@/components/ui/input"
import { useI18n } from "vue-i18n"
import {
  ALL_THINKING_LEVELS,
  setThinkingMapping as setThinkingMap,
  thinkingLevelMode,
  thinkingLevelValue,
  toggleThinkingLevel,
} from "@/lib/thinkingLevels"
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

const thinkingLevels = ALL_THINKING_LEVELS
/** Double-clicking a level opens its provider mapping; null = no editor open. */
const mappingLevel = ref<ThinkingLevel | null>(null)

function thinkingMap(): Record<string, unknown> {
  const map = parsed.value.value?.thinkingLevelMap
  return map && typeof map === "object" && !Array.isArray(map) ? (map as Record<string, unknown>) : {}
}
/** Unmapped levels keep pi's default, which is the "all selected" state. */
function thinkingSelected(level: ThinkingLevel): boolean {
  return thinkingLevelMode(thinkingMap(), level) !== "disabled"
}
function applyThinkingMap(map: Record<string, unknown>) {
  if (!parsed.value.value) return
  const value = { ...parsed.value.value }
  if (Object.keys(map).length) value.thinkingLevelMap = map
  else delete value.thinkingLevelMap
  model.value = JSON.stringify(value, null, 2)
}
function toggleLevel(level: ThinkingLevel) {
  applyThinkingMap(toggleThinkingLevel(thinkingMap(), level))
}
function setThinkingMapping(level: ThinkingLevel, value: unknown) {
  if (typeof value !== "string") return
  applyThinkingMap(setThinkingMap(thinkingMap(), level, value))
}

/** Delay the toggle so the first click of a double click cannot also switch the level. */
let toggleTimer: ReturnType<typeof setTimeout> | null = null
function onLevelClick(level: ThinkingLevel) {
  if (mappingLevel.value === level) return
  if (toggleTimer) clearTimeout(toggleTimer)
  toggleTimer = setTimeout(() => {
    toggleTimer = null
    toggleLevel(level)
  }, 220)
}
function onLevelDblClick(level: ThinkingLevel) {
  if (toggleTimer) {
    clearTimeout(toggleTimer)
    toggleTimer = null
  }
  mappingLevel.value = level
  void nextTick(() => mappingInputFor(level)?.select())
}
/** The inline mapping input for a level, once it has been rendered. */
function mappingInputFor(level: ThinkingLevel): HTMLInputElement | null {
  return document.getElementById(id + "-thinking-" + level + "-map") as HTMLInputElement | null
}
function closeMapping() {
  mappingLevel.value = null
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
        <ButtonGroup class="w-full flex-wrap">
          <Button
            v-for="level in thinkingLevels"
            :id="id + '-thinking-' + level"
            :key="level"
            type="button"
            size="sm"
            variant="outline"
            class="min-w-14 flex-1 font-mono"
            :class="
              thinkingSelected(level)
                ? mappingLevel === level
                  ? 'bg-accent text-accent-foreground'
                  : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                : 'text-muted-foreground line-through'
            "
            :disabled="!!parsed.error"
            :aria-pressed="thinkingSelected(level)"
            :title="t('settings.modelThinkingLevelHint', { level })"
            @click="onLevelClick(level)"
            @dblclick="onLevelDblClick(level)"
          >
            {{ t("chat.thinkingLevels." + level) }}
          </Button>
        </ButtonGroup>
        <div v-if="mappingLevel" class="flex items-center gap-2">
          <code class="font-mono">{{ mappingLevel }}</code>
          <Input
            :id="id + '-thinking-' + mappingLevel + '-map'"
            :model-value="thinkingLevelValue(thinkingMap(), mappingLevel)"
            :placeholder="mappingLevel"
            :aria-label="t('settings.modelThinkingMappingLabel') + ' - ' + mappingLevel"
            class="h-7 w-40 font-mono text-xs"
            @update:model-value="setThinkingMapping(mappingLevel as ThinkingLevel, $event)"
            @keydown.enter.prevent="closeMapping"
            @keydown.esc.prevent="closeMapping"
            @blur="closeMapping"
          />
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
