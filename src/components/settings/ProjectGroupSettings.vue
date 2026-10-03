<script setup lang="ts">
import SettingRow from "@/components/shared/SettingRow.vue"
import SettingHeading from "@/components/shared/SettingHeading.vue"
import SettingDescription from "@/components/shared/SettingDescription.vue"
/** 多目录项目组开关：开启时会话通过内置插件注入工作区清单；关闭后「添加项目」直接选择单目录。 */
import { onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { Switch } from "@/components/ui/switch"
import { getConfig, saveConfig } from "@/api/piClient"
import { tBackendError } from "@/i18n"

const { t } = useI18n()
const enabled = ref(true)
const busy = ref(false)
const error = ref("")

async function load() {
  try {
    enabled.value = (await getConfig()).workspaceGroups !== false
  } catch (e) {
    error.value = tBackendError(e)
  }
}

async function toggle(next: boolean) {
  if (busy.value) return
  busy.value = true
  error.value = ""
  const previous = enabled.value
  enabled.value = next
  try {
    const config = await getConfig()
    // 开启时不写入键，保持「缺省即启用」。
    await saveConfig({ ...config, workspaceGroups: next ? undefined : false })
  } catch (e) {
    enabled.value = previous
    error.value = tBackendError(e)
  } finally {
    busy.value = false
  }
}
onMounted(load)
</script>

<template>
  <SettingRow>
    <div class="min-w-0">
      <SettingHeading id="project-group-label">{{ t("settings.projectGroup") }}</SettingHeading>
      <SettingDescription>{{ t("settings.projectGroupDesc") }}</SettingDescription>
    </div>
    <Switch
      :model-value="enabled"
      :disabled="busy"
      aria-labelledby="project-group-label"
      @update:model-value="(v: boolean) => void toggle(v)"
    />
  </SettingRow>
  <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
</template>
