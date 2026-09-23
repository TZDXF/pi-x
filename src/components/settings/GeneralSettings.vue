<script setup lang="ts">
/** General preferences page: theme, language, and workspace info. */
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { AcceptableValue } from "reka-ui"
import { LOCALES, setLocale, currentLocale, type Locale } from "@/i18n"
import { theme, setTheme, type ThemePreference } from "@/lib/theme"

const { t } = useI18n()

const selectedLocale = ref<Locale>(currentLocale())

function applyLocale(v: Locale) {
  selectedLocale.value = v
  setLocale(v)
}
</script>

<template>
  <div class="setting-row">
    <div>
      <h3 id="theme-label">{{ t("settings.theme") }}</h3>
    </div>
    <Select
      :model-value="theme"
      @update:model-value="(v: AcceptableValue) => setTheme(v as ThemePreference)"
    >
      <SelectTrigger
        class="h-8 w-36 text-xs"
        aria-labelledby="theme-label"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="light">{{ t("settings.themeLight") }}</SelectItem>
        <SelectItem value="dark">{{ t("settings.themeDark") }}</SelectItem>
        <SelectItem value="system">{{ t("settings.themeSystem") }}</SelectItem>
      </SelectContent>
    </Select>
  </div>
  <div class="setting-row">
    <div>
      <h3>{{ t("settings.language") }}</h3>
    </div>
    <Select
      :model-value="selectedLocale"
      @update:model-value="(v: AcceptableValue) => applyLocale(v as Locale)"
    >
      <SelectTrigger class="h-8 w-36 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem v-for="l in LOCALES" :key="l.value" :value="l.value">
          {{ l.label }}
        </SelectItem>
      </SelectContent>
    </Select>
  </div>
  <div class="setting-row">
    <div>
      <h3>{{ t("settings.shortcutsTitle") }}</h3>
      <p>
        {{ t("settings.shortcutSend") }} <kbd>Enter</kbd> ·
        {{ t("settings.shortcutNewline") }} <kbd>Shift + Enter</kbd><br />{{
          t("settings.shortcutStop")
        }}
        <kbd>Esc</kbd> · {{ t("settings.shortcutFileRef") }} <kbd>@</kbd> ·
        {{ t("settings.shortcutCommands") }} <kbd>/</kbd>
      </p>
    </div>
  </div>
</template>
