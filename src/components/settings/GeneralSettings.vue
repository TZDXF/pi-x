<script setup lang="ts">
import SettingRow from "@/components/shared/SettingRow.vue"
import SettingHeading from "@/components/shared/SettingHeading.vue"
import SettingDescription from "@/components/shared/SettingDescription.vue"
import KeyHint from "@/components/shared/KeyHint.vue"
/** General preferences page: workspace, language, and shortcuts. */
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import type { AcceptableValue } from "reka-ui"
import { LOCALES, setLocale, currentLocale, type Locale } from "@/i18n"
import { setTrayLabels, toggleDevtools } from "@/api/piClient"
import { isDesktop } from "@/api/transport"
import { developerModeEnabled, setDeveloperMode } from "@/lib/developerMode"
import { formatComboParts, shortcutCombo } from "@/lib/shortcuts"
import { navigate } from "@/lib/router"
import { Button } from "@/components/ui/button"
import WorkspaceSettings from "@/components/settings/WorkspaceSettings.vue"

const { t } = useI18n()

// The stop action has no default binding (TZD-134); show whatever the user
// recorded, or "not bound" — never advertise Esc as a way out.
const stopCombo = computed(() => shortcutCombo("chat.stop"))
const stopComboParts = computed(() => (stopCombo.value ? formatComboParts(stopCombo.value) : []))

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
      <SettingHeading id="developer-mode-label">{{ t("settings.developerMode") }}</SettingHeading>
      <SettingDescription>
        {{ t("settings.developerModeDesc") }} <KeyHint>F12</KeyHint> {{ t("settings.developerModeDescKeys") }}
        <KeyHint>Ctrl + Shift + I</KeyHint>
      </SettingDescription>
    </div>
    <div class="flex items-center gap-2">
      <Button v-if="developerModeEnabled && isDesktop" variant="outline" size="sm" @click="void toggleDevtools()">
        {{ t("settings.openDevtools") }}
      </Button>
      <Switch
        :model-value="developerModeEnabled"
        aria-labelledby="developer-mode-label"
        @update:model-value="(v: boolean) => setDeveloperMode(v)"
      />
    </div>
  </SettingRow>
  <SettingRow>
    <div class="min-w-0">
      <SettingHeading>{{ t("settings.shortcutsTitle") }}</SettingHeading>
      <SettingDescription>
        {{ t("settings.shortcutSend") }} <KeyHint>Enter</KeyHint> · {{ t("settings.shortcutNewline") }}
        <KeyHint>Shift + Enter</KeyHint><br />{{ t("settings.shortcutStop") }}
        <template v-if="stopCombo">
          <KeyHint v-for="part in stopComboParts" :key="part">{{ part }}</KeyHint>
        </template>
        <span v-else>{{ t("shortcuts.unbound") }}</span>
        · {{ t("settings.shortcutFileRef") }} <KeyHint>@</KeyHint> · {{ t("settings.shortcutCommands") }}
        <KeyHint>/</KeyHint>
      </SettingDescription>
    </div>
    <Button variant="outline" size="sm" @click="navigate('/settings/shortcuts')">
      {{ t("settings.shortcutsOpen") }}
    </Button>
  </SettingRow>
</template>
