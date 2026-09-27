<script setup lang="ts">
/** 自动重试设置页：写入 pi 全局 settings.json 的 `retry` 段。 */
import { onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { getPiSettings, savePiSettings, type RetrySettings } from "@/api/piClient"
import { useUiStore } from "@/stores/conversations"
import SettingRow from "@/components/shared/SettingRow.vue"
import SettingHeading from "@/components/shared/SettingHeading.vue"
import SettingDescription from "@/components/shared/SettingDescription.vue"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"

type BudgetKey = "maxRetries" | "baseDelayMs" | "maxAgentDelayMs"

/** 可调的重试预算字段与允许范围（毫秒）。 */
const BUDGET_FIELDS: { key: BudgetKey; label: string; desc: string; min: number; max: number }[] = [
  { key: "maxRetries", label: "retrySettings.maxRetries", desc: "retrySettings.maxRetriesDesc", min: 0, max: 20 },
  {
    key: "baseDelayMs",
    label: "retrySettings.baseDelayMs",
    desc: "retrySettings.baseDelayMsDesc",
    min: 0,
    max: 600000,
  },
  {
    key: "maxAgentDelayMs",
    label: "retrySettings.maxAgentDelayMs",
    desc: "retrySettings.maxAgentDelayMsDesc",
    min: 0,
    max: 600000,
  },
]

const { t } = useI18n()
const ui = useUiStore()
const loading = ref(true)
const saving = ref(false)
const error = ref("")
const retry = ref<RetrySettings | null>(null)
/** 输入框草稿：失焦或回车才提交，避免每次按键都写盘。数字输入会回传 number。 */
const draft = ref<Record<BudgetKey, string | number>>({ maxRetries: "", baseDelayMs: "", maxAgentDelayMs: "" })

function syncDraft() {
  if (!retry.value) return
  draft.value = {
    maxRetries: String(retry.value.maxRetries),
    baseDelayMs: String(retry.value.baseDelayMs),
    maxAgentDelayMs: String(retry.value.maxAgentDelayMs),
  }
}

async function load() {
  loading.value = true
  error.value = ""
  try {
    const settings = await getPiSettings()
    // 旧版 pi 不返回该段，此时保持 null 并提示升级。
    retry.value = settings.retry ?? null
    syncDraft()
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

async function save(patch: Partial<RetrySettings>) {
  const previous = retry.value
  if (!previous) return
  retry.value = { ...previous, ...patch }
  saving.value = true
  try {
    await savePiSettings({ retry: patch })
    ui.pushToast(t("retrySettings.saved"), "info")
  } catch (e) {
    retry.value = previous
    syncDraft()
    ui.pushToast(String(e), "error")
  } finally {
    saving.value = false
  }
}

async function commitBudget(field: (typeof BUDGET_FIELDS)[number]) {
  const current = retry.value
  if (!current) return
  const raw = String(draft.value[field.key]).trim()
  const value = Number(raw)
  // 空输入不会退化成 0，避免清空输入框后误存。
  if (!raw || !Number.isInteger(value) || value < field.min || value > field.max) {
    draft.value[field.key] = String(current[field.key])
    ui.pushToast(t("retrySettings.invalidNumber", { min: field.min, max: field.max }), "error")
    return
  }
  if (value !== current[field.key]) {
    const patch: Partial<RetrySettings> = {}
    patch[field.key] = value
    await save(patch)
  }
  draft.value[field.key] = String(retry.value?.[field.key] ?? value)
}

onMounted(load)
</script>

<template>
  <p v-if="loading" class="text-sm text-muted-foreground">{{ t("agentConfig.loading") }}</p>
  <div v-else-if="error" role="alert" class="space-y-3">
    <p class="text-sm text-destructive">{{ error }}</p>
    <Button variant="outline" @click="load">{{ t("agentConfig.retry") }}</Button>
  </div>
  <p v-else-if="!retry" class="text-sm text-muted-foreground">{{ t("retrySettings.unsupported") }}</p>
  <fieldset v-else :disabled="saving" class="min-w-0">
    <SettingRow>
      <div class="min-w-0">
        <SettingHeading id="retry-label-enabled">{{ t("retrySettings.enabled") }}</SettingHeading>
        <SettingDescription id="retry-desc-enabled">{{ t("retrySettings.enabledDesc") }}</SettingDescription>
      </div>
      <Switch
        :model-value="retry.enabled"
        aria-labelledby="retry-label-enabled"
        aria-describedby="retry-desc-enabled"
        @update:model-value="value => save({ enabled: Boolean(value) })"
      />
    </SettingRow>
    <SettingRow v-for="field in BUDGET_FIELDS" :key="field.key">
      <div class="min-w-0">
        <SettingHeading :id="`retry-label-${field.key}`">{{ t(field.label) }}</SettingHeading>
        <SettingDescription :id="`retry-desc-${field.key}`">{{ t(field.desc) }}</SettingDescription>
      </div>
      <Input
        :id="`retry-${field.key}`"
        v-model="draft[field.key]"
        type="number"
        class="h-8 w-32 text-xs"
        :min="field.min"
        :max="field.max"
        step="1"
        :aria-labelledby="`retry-label-${field.key}`"
        :aria-describedby="`retry-desc-${field.key}`"
        @change="commitBudget(field)"
      />
    </SettingRow>
    <p class="pt-5 text-xs text-muted-foreground">{{ t("retrySettings.hint") }}</p>
  </fieldset>
</template>
