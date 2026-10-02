<script setup lang="ts">
/** 外观设置页：界面主题与终端配色。 */
import { useI18n } from "vue-i18n"
import type { AcceptableValue } from "reka-ui"
import { isDesktop } from "@/api/transport"
import SettingRow from "@/components/shared/SettingRow.vue"
import SettingHeading from "@/components/shared/SettingHeading.vue"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { theme, setTheme, type ThemePreference } from "@/lib/theme"
import TerminalThemeSettings from "@/components/settings/TerminalThemeSettings.vue"

const { t } = useI18n()
</script>

<template>
  <SettingRow>
    <div class="min-w-0">
      <SettingHeading id="theme-label">{{ t("settings.theme") }}</SettingHeading>
    </div>
    <Select :model-value="theme" @update:model-value="(v: AcceptableValue) => setTheme(v as ThemePreference)">
      <SelectTrigger class="h-8 w-36 text-xs" aria-labelledby="theme-label">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="light">{{ t("settings.themeLight") }}</SelectItem>
        <SelectItem value="dark">{{ t("settings.themeDark") }}</SelectItem>
        <SelectItem value="system">{{ t("settings.themeSystem") }}</SelectItem>
      </SelectContent>
    </Select>
  </SettingRow>
  <TerminalThemeSettings v-if="isDesktop" />
</template>
