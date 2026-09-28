<script setup lang="ts">
/** Notifications page: system notification preferences for turn completion,
 *  questions and sound. */
import SettingRow from "@/components/shared/SettingRow.vue"
import SettingHeading from "@/components/shared/SettingHeading.vue"
import SettingDescription from "@/components/shared/SettingDescription.vue"
import { useI18n } from "vue-i18n"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import type { AcceptableValue } from "reka-ui"
import {
  turnCompleteNotification,
  setTurnCompleteNotification,
  questionNotification,
  setQuestionNotification,
  notificationSound,
  setNotificationSound,
  type TurnCompleteNotification,
  type NotificationSound,
} from "@/lib/notifications"

const { t } = useI18n()
</script>

<template>
  <SettingRow>
    <div class="min-w-0">
      <SettingHeading id="turn-complete-label">{{ t("settings.turnComplete") }}</SettingHeading>
      <SettingDescription>{{ t("settings.turnCompleteDesc") }}</SettingDescription>
    </div>
    <Select
      :model-value="turnCompleteNotification"
      @update:model-value="(v: AcceptableValue) => setTurnCompleteNotification(v as TurnCompleteNotification)"
    >
      <SelectTrigger class="h-8 w-36 text-xs" aria-labelledby="turn-complete-label">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="never">{{ t("settings.notifyNever") }}</SelectItem>
        <SelectItem value="unfocused">{{ t("settings.notifyUnfocused") }}</SelectItem>
        <SelectItem value="always">{{ t("settings.notifyAlways") }}</SelectItem>
      </SelectContent>
    </Select>
  </SettingRow>
  <SettingRow>
    <div class="min-w-0">
      <SettingHeading id="question-notify-label">{{ t("settings.questionNotify") }}</SettingHeading>
      <SettingDescription>{{ t("settings.questionNotifyDesc") }}</SettingDescription>
    </div>
    <Switch
      :model-value="questionNotification"
      aria-labelledby="question-notify-label"
      @update:model-value="(v: boolean) => setQuestionNotification(v)"
    />
  </SettingRow>
  <SettingRow>
    <div class="min-w-0">
      <SettingHeading id="notify-sound-label">{{ t("settings.notifySound") }}</SettingHeading>
      <SettingDescription>{{ t("settings.notifySoundDesc") }}</SettingDescription>
    </div>
    <Select
      :model-value="notificationSound"
      @update:model-value="(v: AcceptableValue) => setNotificationSound(v as NotificationSound)"
    >
      <SelectTrigger class="h-8 w-36 text-xs" aria-labelledby="notify-sound-label">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="default">{{ t("settings.soundDefault") }}</SelectItem>
        <SelectItem value="none">{{ t("settings.soundNone") }}</SelectItem>
      </SelectContent>
    </Select>
  </SettingRow>
</template>
