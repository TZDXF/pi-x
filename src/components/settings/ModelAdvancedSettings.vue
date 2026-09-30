<script setup lang="ts">
import { computed, nextTick, reactive, ref, useId, watch, type Ref } from "vue"
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
import {
  ModelFieldError,
  emptyInputLimitsForm,
  emptyPromptCacheForm,
  fallbackModelsJson,
  inputLimitsForm,
  parseFallbackModels,
  promptCacheForm,
  withFallbackModels,
  withInputLimits,
  withPromptCache,
  type InputLimitsForm,
} from "@/lib/modelLimits"
const model = defineModel<string>({ required: true })
defineProps<{ api: string }>()
const emit = defineEmits<{ "update:invalid": [invalid: boolean] }>()
const { t } = useI18n()
const id = useId()
const parsed = computed(() => {
  try {
    return { value: parseModelAdvanced(model.value), error: "", field: null as ModelFieldError | null }
  } catch (error) {
    return {
      value: null,
      error: String(error),
      field: error instanceof ModelFieldError ? error : null,
    }
  }
})
/** Structured model fields (pi 0.85+) edited on top of the advanced JSON. */
const limits = reactive<InputLimitsForm>(emptyInputLimitsForm())
const promptCache = reactive(emptyPromptCacheForm())
const fallbackModels = ref("[]")
const limitError = ref<ModelFieldError | null>(null)
const promptCacheError = ref<ModelFieldError | null>(null)
const fallbackError = ref<ModelFieldError | null>(null)
/** While a numeric field has focus the advanced JSON must not overwrite it. */
const focused = ref("")

const limitFields = [
  { key: "maxRequestBytes", max: undefined },
  { key: "maxWidth", max: undefined },
  { key: "maxHeight", max: undefined },
  { key: "maxBytes", max: undefined },
  { key: "jpegQuality", max: 100 },
  { key: "maxPerMessage", max: undefined },
  { key: "maxPerRequest", max: undefined },
] as const satisfies readonly { key: keyof InputLimitsForm; max: number | undefined }[]

const cacheTiers = ["short", "long"] as const

const invalid = computed(
  () => !!parsed.value.error || !!limitError.value || !!promptCacheError.value || !!fallbackError.value,
)
watch(invalid, value => emit("update:invalid", value), { immediate: true })

/** Replace the advanced JSON; every setter below edits a copy of it. */
function applyValue(value: Record<string, unknown>) {
  model.value = JSON.stringify(value, null, 2)
}
function commit(run: (value: Record<string, unknown>) => Record<string, unknown>, error: Ref<ModelFieldError | null>) {
  const current = parsed.value.value
  if (!current) return
  try {
    applyValue(run(current))
    error.value = null
  } catch (e) {
    // An invalid value stays in the form; saving is blocked until it is fixed.
    error.value = e instanceof ModelFieldError ? e : new ModelFieldError("notObject", "")
  }
}
function setLimit(key: keyof InputLimitsForm, value: string) {
  limits[key] = value
  commit(value => withInputLimits(value, { ...limits }), limitError)
}
function setPromptCacheLifetime(key: "short" | "long", value: string) {
  promptCache[key] = value
  commit(value => withPromptCache(value, { ...promptCache }), promptCacheError)
}
function setFallbackModels() {
  commit(value => withFallbackModels(value, parseFallbackModels(fallbackModels.value)), fallbackError)
}
function onFallbackInput(event: Event) {
  fallbackModels.value = (event.target as HTMLTextAreaElement).value
}
function fieldErrorText(error: ModelFieldError | null) {
  return error ? t("settings.modelFieldErrors." + error.code, { path: error.path }) : ""
}
/** Refill the structured fields from the advanced JSON, keeping the field the
 *  user is typing in; runs on mount so stored values are never overwritten. */
function syncFromModel() {
  const current = parsed.value.value
  if (!current) return
  const next = inputLimitsForm(current)
  for (const key of Object.keys(next) as (keyof InputLimitsForm)[]) {
    if (key !== focused.value) limits[key] = next[key]
  }
  const cache = promptCacheForm(current)
  if (focused.value !== "cacheShort") promptCache.short = cache.short
  if (focused.value !== "cacheLong") promptCache.long = cache.long
  if (focused.value !== "fallbackModels") fallbackModels.value = fallbackModelsJson(current)
}
watch(parsed, syncFromModel, { immediate: true })

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
          <span class="font-medium">{{ t("settings.modelInputLimits") }}</span>
          <p class="text-muted-foreground leading-relaxed">{{ t("settings.modelInputLimitsHint") }}</p>
        </div>
        <div class="grid grid-cols-2 gap-x-3 gap-y-2 max-[520px]:grid-cols-1">
          <div v-for="field in limitFields" :key="field.key">
            <label class="mb-1 block font-mono" :for="id + '-limit-' + field.key">
              {{ t("settings.modelLimitFields." + field.key) }}
            </label>
            <Input
              :id="id + '-limit-' + field.key"
              :model-value="limits[field.key]"
              type="number"
              min="1"
              inputmode="numeric"
              :max="field.max"
              :aria-invalid="!!limitError"
              :placeholder="t('settings.modelLimitInherit')"
              class="h-7 text-xs"
              @update:model-value="setLimit(field.key, String($event))"
              @focus="focused = field.key"
              @blur="focused = ''"
            />
          </div>
        </div>
        <p v-if="limitError" role="alert" class="text-destructive break-all">{{ fieldErrorText(limitError) }}</p>
      </div>
      <div class="border-border space-y-2 rounded-md border p-2">
        <div class="space-y-1">
          <span class="font-medium">{{ t("settings.modelPromptCache") }}</span>
          <p class="text-muted-foreground leading-relaxed">{{ t("settings.modelPromptCacheHint") }}</p>
        </div>
        <div class="grid grid-cols-2 gap-3 max-[520px]:grid-cols-1">
          <div v-for="tier in cacheTiers" :key="tier">
            <label class="mb-1 block font-mono" :for="id + '-cache-' + tier">
              {{ t("settings.modelPromptCacheTiers." + tier) }}
            </label>
            <Input
              :id="id + '-cache-' + tier"
              :model-value="promptCache[tier]"
              type="number"
              min="1"
              inputmode="numeric"
              :aria-invalid="!!promptCacheError"
              :placeholder="t('settings.modelPromptCacheInherit')"
              class="h-7 text-xs"
              @update:model-value="setPromptCacheLifetime(tier, String($event))"
              @focus="focused = 'cache' + tier"
              @blur="focused = ''"
            />
          </div>
        </div>
        <p v-if="promptCacheError" role="alert" class="text-destructive break-all">
          {{ fieldErrorText(promptCacheError) }}
        </p>
      </div>
      <div v-if="api === 'anthropic-messages'" class="border-border space-y-2 rounded-md border p-2">
        <div class="space-y-1">
          <span class="font-medium">{{ t("settings.modelFallbackModels") }}</span>
          <p class="text-muted-foreground leading-relaxed">{{ t("settings.modelFallbackModelsHint") }}</p>
        </div>
        <textarea
          :id="id + '-fallback-models'"
          :value="fallbackModels"
          rows="4"
          spellcheck="false"
          :aria-invalid="!!fallbackError"
          class="bg-background border-border w-full rounded-md border p-2 font-mono text-xs"
          @input="onFallbackInput"
          @change="setFallbackModels"
          @focus="focused = 'fallbackModels'"
          @blur="focused = ''"
        />
        <p v-if="fallbackError" role="alert" class="text-destructive break-all">
          {{ fieldErrorText(fallbackError) }}
        </p>
      </div>
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
      <p v-if="parsed.error" role="alert" class="text-destructive break-all">
        <template v-if="parsed.field">{{ fieldErrorText(parsed.field) }}</template>
        <template v-else>{{ parsed.error }}</template>
      </p>
    </div>
  </details>
</template>
