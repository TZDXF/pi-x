<script setup lang="ts">
import SettingRow from "@/components/shared/SettingRow.vue"
import SettingHeading from "@/components/shared/SettingHeading.vue"
import SettingDescription from "@/components/shared/SettingDescription.vue"
/** 新会话创建 worktree 的父目录：支持绝对路径与相对项目的相对路径，留空沿用默认位置。 */
import { onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { chooseDirectoryPath, getConfig, saveConfig } from "@/api/piClient"
import { isDesktop } from "@/api/transport"
import { tBackendError } from "@/i18n"

const { t } = useI18n()
/** 配置中的显式目录；null 表示沿用默认目录。 */
const configured = ref<string | null>(null)
const draft = ref("")
const busy = ref(false)
const error = ref("")

/** 路径在会话创建时按项目解析，这里只需保存；空值回到默认目录。 */
async function save(next: string | null) {
  if (busy.value) return
  busy.value = true
  error.value = ""
  try {
    const config = await getConfig()
    await saveConfig({ ...config, worktreeDir: next ?? undefined })
    configured.value = next
    draft.value = next ?? ""
  } catch (e) {
    error.value = tBackendError(e)
  } finally {
    busy.value = false
  }
}
async function commit() {
  const value = draft.value.trim()
  if (value === (configured.value ?? "")) return
  return save(value || null)
}
async function choose() {
  try {
    const picked = await chooseDirectoryPath(t("workspace.worktreeDirLabel"))
    if (picked) await save(picked)
  } catch (e) {
    error.value = tBackendError(e)
  }
}
async function load() {
  try {
    const config = await getConfig()
    configured.value = config.worktreeDir?.trim() || null
    draft.value = configured.value ?? ""
  } catch (e) {
    error.value = tBackendError(e)
  }
}
onMounted(load)
</script>

<template>
  <SettingRow>
    <div class="min-w-0">
      <SettingHeading id="worktree-dir-label">{{ t("workspace.worktreeDirLabel") }}</SettingHeading>
      <SettingDescription>
        {{ t("workspace.worktreeDirDesc") }}
      </SettingDescription>
    </div>
    <div class="flex min-w-0 shrink-0 items-center gap-2 max-[640px]:w-full">
      <Input
        v-model="draft"
        class="w-64 text-xs max-[640px]:w-full"
        :placeholder="t('workspace.worktreeDirPlaceholder')"
        :aria-label="t('workspace.worktreeDirLabel')"
        :disabled="busy"
        @keydown.enter="commit"
        @blur="commit"
      />
      <Button v-if="isDesktop" variant="outline" size="sm" :disabled="busy" @click="choose">
        {{ t("workspace.worktreeDirChoose") }}
      </Button>
      <Button variant="outline" size="sm" :disabled="busy || !configured" @click="save(null)">
        {{ t("workspace.worktreeDirReset") }}
      </Button>
    </div>
  </SettingRow>
  <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
</template>
