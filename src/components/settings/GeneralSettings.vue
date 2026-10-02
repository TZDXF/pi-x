<script setup lang="ts">
import SettingRow from "@/components/shared/SettingRow.vue"
import SettingHeading from "@/components/shared/SettingHeading.vue"
import SettingDescription from "@/components/shared/SettingDescription.vue"
import KeyHint from "@/components/shared/KeyHint.vue"
/** General preferences page: workspace, language, and shortcuts. */
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { AcceptableValue } from "reka-ui"
import { LOCALES, setLocale, currentLocale, type Locale } from "@/i18n"
import { setTrayLabels } from "@/api/piClient"
import { navigate } from "@/lib/router"
import { Button } from "@/components/ui/button"
import WorkspaceSettings from "@/components/settings/WorkspaceSettings.vue"

const { t } = useI18n()

const selectedLocale = ref<Locale>(currentLocale())

function applyLocale(v: Locale) {
  selectedLocale.value = v
  setLocale(v)
  void setTrayLabels(t("tray.show"), t("tray.quit")).catch(() => {})
}
</script>

<template>
  <WorkspaceSettings />
  <SettingRow>
    <div class="min-w-0">
      <SettingHeading>{{ t("settings.language") }}</SettingHeading>
    </div>
    <Select :model-value="selectedLocale" @update:model-value="(v: AcceptableValue) => applyLocale(v as Locale)">
      <SelectTrigger class="h-8 w-36 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem v-for="l in LOCALES" :key="l.value" :value="l.value">
          {{ l.label }}
        </SelectItem>
      </SelectContent>
    </Select>
  </SettingRow>
  <SettingRow>
    <div class="min-w-0">
      <SettingHeading>{{ t("settings.shortcutsTitle") }}</SettingHeading>
      <SettingDescription>
        {{ t("settings.shortcutSend") }} <KeyHint>Enter</KeyHint> · {{ t("settings.shortcutNewline") }}
        <KeyHint>Shift + Enter</KeyHint><br />{{ t("settings.shortcutStop") }} <KeyHint>Esc</KeyHint> ·
        {{ t("settings.shortcutFileRef") }} <KeyHint>@</KeyHint> · {{ t("settings.shortcutCommands") }}
        <KeyHint>/</KeyHint>
      </SettingDescription>
    </div>
    <Button variant="outline" size="sm" @click="navigate('/settings/shortcuts')">
      {{ t("settings.shortcutsOpen") }}
    </Button>
  </SettingRow>
</template>
