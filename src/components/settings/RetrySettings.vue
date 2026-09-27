<script setup lang="ts">
/** 自动重试设置页：只调整 pi 全局 settings.json 里的重试次数。 */
import { onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { getPiSettings, savePiSettings } from "@/api/piClient"
import { useUiStore } from "@/stores/conversations"
import SettingRow from "@/components/shared/SettingRow.vue"
import SettingHeading from "@/components/shared/SettingHeading.vue"
import SettingDescription from "@/components/shared/SettingDescription.vue"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

const MIN_ATTEMPTS = 0
const MAX_ATTEMPTS = 20

const { t } = useI18n()
const ui = useUiStore()
const loading = ref(true)
const saving = ref(false)
const error = ref("")
/** 已保存的重试次数；旧版 pi 不支持该设置时为 null。 */
const attempts = ref<number | null>(null)
/** 输入框草稿：失焦或回车才提交，避免每次按键都写盘。数字输入会回传 number。 */
const draft = ref<string | number>("")

async function load() {
  loading.value = true
  error.value = ""
  try {
    const settings = await getPiSettings()
    attempts.value = settings.retry?.maxRetries ?? null
    draft.value = attempts.value === null ? "" : String(attempts.value)
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

async function commit() {
  const previous = attempts.value
  if (previous === null) return
  const raw = String(draft.value).trim()
  const value = Number(raw)
  // 空输入不会退化成 0，避免清空输入框后误存。
  if (!raw || !Number.isInteger(value) || value < MIN_ATTEMPTS || value > MAX_ATTEMPTS) {
    draft.value = String(previous)
    ui.pushToast(t("retrySettings.invalidNumber", { min: MIN_ATTEMPTS, max: MAX_ATTEMPTS }), "error")
    return
  }
  draft.value = String(value)
  if (value === previous) return
  attempts.value = value
  saving.value = true
  try {
    await savePiSettings({ retry: { maxRetries: value } })
    ui.pushToast(t("retrySettings.saved"), "info")
  } catch (e) {
    attempts.value = previous
    draft.value = String(previous)
    ui.pushToast(String(e), "error")
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <p v-if="loading" class="text-sm text-muted-foreground">{{ t("agentConfig.loading") }}</p>
  <div v-else-if="error" role="alert" class="space-y-3">
    <p class="text-sm text-destructive">{{ error }}</p>
    <Button variant="outline" @click="load">{{ t("agentConfig.retry") }}</Button>
  </div>
  <p v-else-if="attempts === null" class="text-sm text-muted-foreground">{{ t("retrySettings.unsupported") }}</p>
  <fieldset v-else :disabled="saving" class="min-w-0">
    <SettingRow>
      <div class="min-w-0">
        <SettingHeading id="retry-attempts-label">{{ t("retrySettings.maxRetries") }}</SettingHeading>
        <SettingDescription id="retry-attempts-desc">{{ t("retrySettings.maxRetriesDesc") }}</SettingDescription>
      </div>
      <Input
        id="retry-attempts"
        v-model="draft"
        type="number"
        class="h-8 w-32 text-xs"
        :min="MIN_ATTEMPTS"
        :max="MAX_ATTEMPTS"
        step="1"
        aria-labelledby="retry-attempts-label"
        aria-describedby="retry-attempts-desc"
        @change="commit"
      />
    </SettingRow>
    <p class="flex items-center gap-3 pt-5 text-xs text-muted-foreground">
      <span>{{ t("retrySettings.hint") }}</span>
      <span v-if="saving" role="status">{{ t("agentConfig.saving") }}</span>
    </p>
  </fieldset>
</template>
