<script setup lang="ts">
/** Terminal panel color scheme: presets plus per-color overrides (desktop only). */
import SettingRow from "@/components/shared/SettingRow.vue"
import SettingHeading from "@/components/shared/SettingHeading.vue"
import SettingDescription from "@/components/shared/SettingDescription.vue"
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { AcceptableValue } from "reka-ui"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  TERMINAL_PRESETS,
  terminalPresetLabelKey,
  terminalTheme,
  resetTerminalTheme,
  setTerminalColor,
  setTerminalPreset,
  type TerminalThemeKey,
} from "@/lib/terminalTheme"

const { t } = useI18n()

const presetOptions = computed(() =>
  (Object.keys(TERMINAL_PRESETS) as (keyof typeof TERMINAL_PRESETS)[]).map(key => ({
    value: key as TerminalThemeKey,
    label: t(terminalPresetLabelKey(key)),
  })),
)

const colorFields = [
  { key: "background", labelKey: "settings.terminalColorBackground" },
  { key: "foreground", labelKey: "settings.terminalColorForeground" },
  { key: "cursor", labelKey: "settings.terminalColorCursor" },
  { key: "selectionBackground", labelKey: "settings.terminalColorSelection" },
] as const

function onPresetChange(v: AcceptableValue) {
  setTerminalPreset(v as TerminalThemeKey)
}
</script>

<template>
  <SettingRow>
    <div class="min-w-0">
      <SettingHeading id="terminal-theme-label">{{ t("settings.terminalTheme") }}</SettingHeading>
      <SettingDescription>{{ t("settings.terminalThemeDesc") }}</SettingDescription>
    </div>
    <Select :model-value="terminalTheme.preset" @update:model-value="onPresetChange">
      <SelectTrigger class="h-8 w-36 text-xs" aria-labelledby="terminal-theme-label">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem v-for="option in presetOptions" :key="option.value" :value="option.value">
          {{ option.label }}
        </SelectItem>
        <SelectItem v-if="terminalTheme.preset === 'custom'" value="custom">
          {{ t("settings.terminalPresetCustom") }}
        </SelectItem>
      </SelectContent>
    </Select>
  </SettingRow>
  <SettingRow>
    <div class="min-w-0">
      <SettingHeading>{{ t("settings.terminalColorsTitle") }}</SettingHeading>
      <SettingDescription>{{ t("settings.terminalColorsDesc") }}</SettingDescription>
    </div>
    <div class="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
      <label v-for="field in colorFields" :key="field.key" class="flex items-center gap-1.5 text-xs">
        <span class="text-muted-foreground">{{ t(field.labelKey) }}</span>
        <input
          type="color"
          class="border-border size-6 cursor-pointer rounded-sm border p-0.5"
          :value="terminalTheme.colors[field.key]"
          :aria-label="t(field.labelKey)"
          @input="setTerminalColor(field.key, ($event.target as HTMLInputElement).value)"
        />
      </label>
    </div>
  </SettingRow>
  <div v-if="terminalTheme.preset === 'custom'" class="flex justify-end">
    <Button variant="outline" size="sm" @click="resetTerminalTheme">{{ t("settings.terminalThemeReset") }}</Button>
  </div>
</template>
