<script setup lang="ts">
/** 跟进消息投递设置：读写 pi 全局 settings.json 的 `followUpMode`，
 *  并通过 set_follow_up_mode 对运行中的会话即时生效。 */
import { onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { getPiSettings, savePiSettings } from "@/api/piClient"
import type { QueueDeliveryMode } from "@/api/protocol"
import { allConversations, useUiStore } from "@/stores/conversations"
import SettingRow from "@/components/shared/SettingRow.vue"
import SettingHeading from "@/components/shared/SettingHeading.vue"
import SettingDescription from "@/components/shared/SettingDescription.vue"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import type { AcceptableValue } from "reka-ui"

const MODES: readonly QueueDeliveryMode[] = ["one-at-a-time", "all"]
/** pi 的默认值；设置未写入或旧版 pi 不回报该键时按它展示。 */
const DEFAULT_MODE: QueueDeliveryMode = "one-at-a-time"

const { t } = useI18n()
const ui = useUiStore()
const loading = ref(true)
const saving = ref(false)
const error = ref("")
const mode = ref<QueueDeliveryMode>(DEFAULT_MODE)

async function load() {
  loading.value = true
  error.value = ""
  try {
    const settings = await getPiSettings()
    mode.value = settings.followUpMode ?? DEFAULT_MODE
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

async function commit(selected: AcceptableValue) {
  const next = selected as QueueDeliveryMode
  if (!MODES.includes(next) || next === mode.value) return
  const previous = mode.value
  mode.value = next
  saving.value = true
  try {
    await savePiSettings({ followUpMode: next })
    // 已在运行的会话逐个切换；新会话由 pi 读取全局设置自动生效。
    // 失败的会话重新打开时会经 applyConfiguredFollowUpMode 补上新模式。
    const running = allConversations().filter(conversation => conversation.started)
    let failures = 0
    let firstError = ""
    for (const conversation of running) {
      try {
        await conversation.setFollowUpMode(next)
      } catch (e) {
        if (!firstError) firstError = String(e)
        failures++
      }
    }
    if (running.length > 0 && failures === running.length) {
      mode.value = previous
      ui.pushToast(firstError, "error")
    } else {
      if (failures > 0) ui.pushToast(t("queueMode.partialSync", failures), "warning")
      ui.pushToast(t("queueMode.saved"), "info")
    }
  } catch (e) {
    mode.value = previous
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
  <fieldset v-else :disabled="saving" class="min-w-0">
    <SettingRow>
      <div class="min-w-0">
        <SettingHeading id="follow-up-mode-label">{{ t("queueMode.title") }}</SettingHeading>
        <SettingDescription>{{ t("queueMode.desc") }}</SettingDescription>
      </div>
      <Select :model-value="mode" @update:model-value="commit">
        <SelectTrigger class="h-8 w-44 text-xs" aria-labelledby="follow-up-mode-label">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="one-at-a-time">{{ t("queueMode.oneAtATime") }}</SelectItem>
          <SelectItem value="all">{{ t("queueMode.all") }}</SelectItem>
        </SelectContent>
      </Select>
    </SettingRow>
  </fieldset>
</template>
