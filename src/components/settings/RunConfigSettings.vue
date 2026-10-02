<script setup lang="ts">
/** 配置设置页：运行方式、自动重试与跟进消息投递等会话运行行为。 */
import { useI18n } from "vue-i18n"
import type { AcceptableValue } from "reka-ui"
import { isDesktop } from "@/api/transport"
import SettingRow from "@/components/shared/SettingRow.vue"
import SettingHeading from "@/components/shared/SettingHeading.vue"
import SettingDescription from "@/components/shared/SettingDescription.vue"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { runningBehavior, setRunningBehavior, type RunningBehavior } from "@/lib/runningBehavior"
import RetrySettings from "@/components/settings/RetrySettings.vue"
import QueueModeSettings from "@/components/settings/QueueModeSettings.vue"

const { t } = useI18n()
</script>

<template>
  <SettingRow>
    <div class="min-w-0">
      <SettingHeading id="running-behavior-label">{{ t("chat.runningBehavior") }}</SettingHeading>
      <SettingDescription>{{ t("settings.runningBehaviorDesc") }}</SettingDescription>
    </div>
    <Select
      :model-value="runningBehavior"
      @update:model-value="(v: AcceptableValue) => setRunningBehavior(v as RunningBehavior)"
    >
      <SelectTrigger class="h-8 w-36 text-xs" aria-labelledby="running-behavior-label">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="queue">{{ t("chat.addToQueue") }}</SelectItem>
        <SelectItem value="steer">{{ t("chat.steer") }}</SelectItem>
      </SelectContent>
    </Select>
  </SettingRow>
  <RetrySettings v-if="isDesktop" />
  <QueueModeSettings v-if="isDesktop" />
</template>
