<script setup lang="ts">
import SettingRow from '@/components/shared/SettingRow.vue'
import SettingHeading from '@/components/shared/SettingHeading.vue'
import SettingDescription from '@/components/shared/SettingDescription.vue'
/** 无项目会话的工作目录：默认 `~/.pix/workspace`，可改为任意目录。 */
import { computed, onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { chooseDirectoryPath, getConfig, saveConfig } from "@/api/piClient"
import { isAbsolutePath, samePath } from "@/lib/paths"
import { isDesktop } from "@/api/transport"
import { tBackendError } from "@/i18n"
import { useWorkspaceStore } from "@/stores/workspace"

const { t } = useI18n()
const workspace = useWorkspaceStore()
/** 配置中的显式目录；null 表示沿用默认目录。 */
const configured = ref<string | null>(null)
const draft = ref("")
const busy = ref(false)
const error = ref("")

const defaultDir = computed(() => workspace.projectlessDefault || workspace.projectless)

/** 保存后立即解析；目录不可用（如盘符不存在）时回滚配置，避免每次启动都失败。 */
async function save(next: string | null) {
  if (busy.value) return
  busy.value = true
  error.value = ""
  try {
    const config = await getConfig()
    const previous = config.projectlessDir ?? null
    await saveConfig({ ...config, projectlessDir: next ?? undefined })
    try {
      await workspace.refreshProjectless()
    } catch (e) {
      await saveConfig({ ...config, projectlessDir: previous ?? undefined }).catch(() => {})
      throw e
    }
    configured.value = next
    draft.value = next ?? ""
  } catch (e) {
    error.value = tBackendError(e)
  } finally {
    busy.value = false
  }
}
/** 提交输入框内容；空值回到默认目录，非法值只提示不保存。 */
async function commit() {
  const value = draft.value.trim()
  if (value === (configured.value ?? "")) return
  if (!value) return save(null)
  if (!isAbsolutePath(value)) {
    error.value = t("projectless.invalidPath")
    return
  }
  // 与默认目录一致时不必固化进配置，换机器或改主目录后仍跟随默认值。
  if (samePath(value, defaultDir.value)) return save(null)
  return save(value)
}
async function choose() {
  try {
    const picked = await chooseDirectoryPath(t("projectless.settingsLabel"))
    if (picked) await save(picked)
  } catch (e) {
    error.value = tBackendError(e)
  }
}
async function load() {
  try {
    const config = await getConfig()
    configured.value = config.projectlessDir?.trim() || null
    draft.value = configured.value ?? ""
  } catch (e) {
    error.value = tBackendError(e)
  }
  // 默认目录由后端解析并创建；远程模式下此前可能尚未解析过。
  try { await workspace.ensureProjectless() } catch (e) { error.value = tBackendError(e) }
}
onMounted(load)
</script>

<template>
  <SettingRow>
    <div class="min-w-0">
      <SettingHeading id="projectless-dir-label">{{ t("projectless.settingsLabel") }}</SettingHeading>
      <SettingDescription>
        {{ t("projectless.settingsDesc", { path: defaultDir || "~/.pix/workspace" }) }}
      </SettingDescription>
    </div>
    <div class="flex min-w-0 shrink-0 items-center gap-2 max-[640px]:w-full">
      <Input
        v-model="draft"
        class="w-64 text-xs max-[640px]:w-full"
        :placeholder="defaultDir || '~/.pix/workspace'"
        :aria-label="t('projectless.settingsLabel')"
        :disabled="busy"
        @keydown.enter="commit"
        @blur="commit"
      />
      <Button v-if="isDesktop" variant="outline" size="sm" :disabled="busy" @click="choose">
        {{ t("projectless.choose") }}
      </Button>
      <Button variant="outline" size="sm" :disabled="busy || !configured" @click="save(null)">
        {{ t("projectless.reset") }}
      </Button>
    </div>
  </SettingRow>
  <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
</template>
