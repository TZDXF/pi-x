<script setup lang="ts">
/** General preferences page: tray behavior, theme, language, and workspace info. */
import { onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { AcceptableValue } from "reka-ui"
import { isDesktop } from "@/api/transport"
import { getConfig, saveConfig } from "@/api/piClient"
import { useUiStore } from "@/stores/ui"
import { LOCALES, setLocale, currentLocale, type Locale } from "@/i18n"
import { theme, setTheme, type ThemePreference } from "@/lib/theme"

const { t } = useI18n()
const ui = useUiStore()

const selectedLocale = ref<Locale>(currentLocale())

function applyLocale(v: Locale) {
  selectedLocale.value = v
  setLocale(v)
}

const windowPreferencesBusy = ref(false)
const minimizeToTray = ref(false)
const closeToTray = ref(false)

onMounted(async () => {
  if (!isDesktop) return
  try {
    const c = await getConfig()
    minimizeToTray.value = c.minimizeToTray ?? false
    closeToTray.value = c.closeToTray ?? false
  } catch {
    // Keep defaults when the config cannot be loaded.
  }
})

async function saveWindowPreferences() {
  windowPreferencesBusy.value = true
  try {
    const c = await getConfig()
    await saveConfig({ ...c, minimizeToTray: minimizeToTray.value, closeToTray: closeToTray.value })
  } catch (e) {
    ui.pushToast(String(e), "error")
    const c = await getConfig().catch(() => null)
    if (c) { minimizeToTray.value = c.minimizeToTray ?? false; closeToTray.value = c.closeToTray ?? false }
  } finally { windowPreferencesBusy.value = false }
}
</script>

<template>
  <template v-if="isDesktop">
    <label class="setting-row">
      <div><h3>{{ t("settings.minimizeToTray") }}</h3><p>{{ t("settings.minimizeToTrayDesc") }}</p></div>
      <input v-model="minimizeToTray" type="checkbox" :disabled="windowPreferencesBusy" @change="saveWindowPreferences" />
    </label>
    <label class="setting-row">
      <div><h3>{{ t("settings.closeToTray") }}</h3><p>{{ t("settings.closeToTrayDesc") }}</p></div>
      <input v-model="closeToTray" type="checkbox" :disabled="windowPreferencesBusy" @change="saveWindowPreferences" />
    </label>
    <p class="text-xs text-muted-foreground">{{ t("settings.dataDirectory") }}: ~/.pix</p>
  </template>
  <div class="setting-row">
    <div>
      <h3 id="theme-label">{{ t("settings.theme") }}</h3>
      <p id="theme-description">{{ t("settings.themeDesc") }}</p>
    </div>
    <Select
      :model-value="theme"
      @update:model-value="(v: AcceptableValue) => setTheme(v as ThemePreference)"
    >
      <SelectTrigger
        class="h-8 w-36 text-xs"
        aria-labelledby="theme-label"
        aria-describedby="theme-description"
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
      <p>{{ t("settings.languageDesc") }}</p>
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
      <h3>{{ t("settings.workspaceTitle") }}</h3>
      <p>{{ t("settings.workspaceDesc") }}</p>
    </div>
    <span class="setting-badge">{{ t("settings.workspaceBadge") }}</span>
  </div>
  <div class="setting-row">
    <div>
      <h3>{{ t("settings.sessionsTitle") }}</h3>
      <p>{{ t("settings.sessionsDesc") }}</p>
    </div>
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
