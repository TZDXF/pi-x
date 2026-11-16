<script setup lang="ts">
/** Pi 全局提示缓存预热策略；可选值由已安装 Pi 的 settings schema 决定。 */
import { onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import type { AcceptableValue } from "reka-ui"
import { getPiSettings, savePiSettings, type CacheWarmingMode } from "@/api/piClient"
import { useUiStore } from "@/stores/conversations"
import SettingRow from "@/components/shared/SettingRow.vue"
import SettingHeading from "@/components/shared/SettingHeading.vue"
import SettingDescription from "@/components/shared/SettingDescription.vue"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

const { t } = useI18n()
const ui = useUiStore()
const loading = ref(true)
const saving = ref(false)
const error = ref("")
const mode = ref<CacheWarmingMode>("idle")
const modes = ref<CacheWarmingMode[]>([])

async function load() {
  loading.value = true
  error.value = ""
  try {
    const settings = await getPiSettings()
    modes.value = settings.cacheWarmingModes ?? []
    mode.value = settings.cacheWarming ?? modes.value[0] ?? "idle"
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

async function commit(selected: AcceptableValue) {
  const next = selected as CacheWarmingMode
  if (!modes.value.includes(next) || next === mode.value) return
  const previous = mode.value
  mode.value = next
  saving.value = true
  try {
    await savePiSettings({ cacheWarming: next })
    ui.pushToast(t("cacheWarming.saved"), "info")
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
        <SettingHeading id="cache-warming-label">{{ t("cacheWarming.title") }}</SettingHeading>
        <SettingDescription id="cache-warming-desc">{{ t("cacheWarming.desc") }}</SettingDescription>
      </div>
      <Select v-if="modes.length" :model-value="mode" @update:model-value="commit">
        <SelectTrigger
          class="h-8 w-52 text-xs"
          aria-labelledby="cache-warming-label"
          aria-describedby="cache-warming-desc"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="option in modes" :key="option" :value="option">
            {{ t("cacheWarming.modes." + option) }}
          </SelectItem>
        </SelectContent>
      </Select>
      <p v-else class="max-w-52 text-xs text-muted-foreground">{{ t("cacheWarming.unsupported") }}</p>
    </SettingRow>
  </fieldset>
</template>
