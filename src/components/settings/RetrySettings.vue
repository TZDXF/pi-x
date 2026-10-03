<script setup lang="ts">
/** 重试与压缩设置页：调整 pi 全局 settings.json 的静态重试次数，并提供
 *  运行时开关（set_auto_retry / set_auto_compaction，对运行中的会话即时生效）。 */
import { onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { getPiSettings, savePiSettings } from "@/api/piClient"
import { allConversations, useUiStore } from "@/stores/conversations"
import SettingRow from "@/components/shared/SettingRow.vue"
import SettingHeading from "@/components/shared/SettingHeading.vue"
import SettingDescription from "@/components/shared/SettingDescription.vue"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"

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
/** 运行时开关；旧版 pi 缺省 true。 */
const autoRetry = ref(true)
const autoCompaction = ref(true)
const toggling = ref<"retry" | "compaction" | null>(null)

async function load() {
  loading.value = true
  error.value = ""
  try {
    const settings = await getPiSettings()
    attempts.value = settings.retry?.maxRetries ?? null
    draft.value = attempts.value === null ? "" : String(attempts.value)
    autoRetry.value = settings.retry?.enabled ?? true
    autoCompaction.value = settings.compaction?.enabled ?? true
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

/** 写入全局设置并对运行中的会话逐个下发运行时命令；全部失败才回退开关。 */
async function commitToggle(
  kind: "retry" | "compaction",
  next: boolean,
  apply: (conversation: ReturnType<typeof allConversations>[number]) => Promise<void>,
) {
  const toggle = kind === "retry" ? autoRetry : autoCompaction
  const previous = toggle.value
  if (next === previous) return
  toggle.value = next
  toggling.value = kind
  try {
    if (kind === "retry") await savePiSettings({ retry: { enabled: next } })
    else await savePiSettings({ compaction: { enabled: next } })
    const running = allConversations().filter(conversation => conversation.started)
    let failures = 0
    let firstError = ""
    for (const conversation of running) {
      try {
        await apply(conversation)
      } catch (e) {
        if (!firstError) firstError = String(e)
        failures++
      }
    }
    if (running.length > 0 && failures === running.length) {
      toggle.value = previous
      ui.pushToast(firstError, "error")
    } else {
      if (failures > 0) ui.pushToast(t("retrySettings.partialSync", failures), "warning")
      ui.pushToast(t("retrySettings.runtimeSaved"), "info")
    }
  } catch (e) {
    toggle.value = previous
    ui.pushToast(String(e), "error")
  } finally {
    toggling.value = null
  }
}

const setAutoRetryEnabled = (next: boolean) =>
  commitToggle("retry", next, conversation => conversation.setAutoRetry(next))
const setAutoCompactionEnabled = (next: boolean) =>
  commitToggle("compaction", next, conversation => conversation.setAutoCompaction(next))

onMounted(load)
</script>

<template>
  <p v-if="loading" class="text-sm text-muted-foreground">{{ t("agentConfig.loading") }}</p>
  <div v-else-if="error" role="alert" class="space-y-3">
    <p class="text-sm text-destructive">{{ error }}</p>
    <Button variant="outline" @click="load">{{ t("agentConfig.retry") }}</Button>
  </div>
  <fieldset :disabled="saving || toggling !== null" class="min-w-0 space-y-5">
    <SettingRow>
      <div class="min-w-0">
        <SettingHeading id="retry-auto-retry-label">{{ t("retrySettings.autoRetry") }}</SettingHeading>
        <SettingDescription id="retry-auto-retry-desc">{{ t("retrySettings.autoRetryDesc") }}</SettingDescription>
      </div>
      <Switch
        :model-value="autoRetry"
        aria-labelledby="retry-auto-retry-label"
        @update:model-value="setAutoRetryEnabled"
      />
    </SettingRow>
    <SettingRow>
      <div class="min-w-0">
        <SettingHeading id="retry-auto-compaction-label">{{ t("retrySettings.autoCompaction") }}</SettingHeading>
        <SettingDescription id="retry-auto-compaction-desc">
          {{ t("retrySettings.autoCompactionDesc") }}
        </SettingDescription>
      </div>
      <Switch
        :model-value="autoCompaction"
        aria-labelledby="retry-auto-compaction-label"
        @update:model-value="setAutoCompactionEnabled"
      />
    </SettingRow>
    <p class="flex items-center gap-3 text-xs text-muted-foreground">
      <span>{{ t("retrySettings.runtimeHint") }}</span>
      <span v-if="toggling" role="status">{{ t("agentConfig.saving") }}</span>
    </p>
    <template v-if="attempts !== null">
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
      <p class="flex items-center gap-3 text-xs text-muted-foreground">
        <span>{{ t("retrySettings.hint") }}</span>
        <span v-if="saving" role="status">{{ t("agentConfig.saving") }}</span>
      </p>
    </template>
    <p v-else class="text-sm text-muted-foreground">{{ t("retrySettings.unsupported") }}</p>
  </fieldset>
</template>
