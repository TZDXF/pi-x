<script setup lang="ts">
import { computed, watch } from "vue"
import { LoaderCircle, ShieldCheck } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import { trustStatus, trustSave, sshTrustStatus, sshTrustSave } from "@/api/piClient"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useProjectTrust } from "@/composables/useProjectTrust"
import { useUiStore } from "@/stores/conversations"
import type { SshConnectionRef } from "@/lib/ssh"
import { tBackendError } from "@/i18n"

/**
 * 项目信任的行内标注：编辑项目时挂在目录列表的每一行（远程项目挂在路径行）。
 * 已信任的项目不再展示任何信任状态；未信任项目只留“未信任”标注与信任动作，
 * 保存成功的提示交给 toast，避免行内出现常驻文案。
 */
const props = defineProps<{ project: string; active: boolean; connections: readonly SshConnectionRef[] }>()
const { t } = useI18n()
const ui = useUiStore()
const { status, saving, saved, error, trusted, refresh, trust } = useProjectTrust({
  project: () => props.project,
  active: () => props.active,
  connections: () => props.connections,
  api: { trustStatus, trustSave, sshTrustStatus, sshTrustSave },
})
const warning = computed(() => t(status.value?.hasTrustRequiringResources ? "trust.warning" : "trust.warningEmpty"))
const errorText = computed(() => (error.value ? tBackendError(error.value) : ""))
watch(saved, value => {
  if (value) ui.pushToast(t("projectDialog.trustSaved"), "info")
})
</script>

<template>
  <span v-if="error" class="inline-flex min-w-0 shrink items-center gap-1">
    <span role="alert" class="truncate text-xs text-destructive" :title="errorText">{{ errorText }}</span>
    <Button type="button" variant="ghost" size="xs" @click="refresh">{{ t("common.retry") }}</Button>
  </span>
  <span v-else-if="status && !trusted" class="inline-flex shrink-0 items-center gap-1.5">
    <Badge variant="outline" class="shrink-0 border-amber-600/40 text-amber-700 dark:text-amber-400" :title="warning">{{
      t("projectDialog.untrusted")
    }}</Badge>
    <Button type="button" variant="outline" size="xs" :disabled="saving" :title="warning" @click="trust">
      <LoaderCircle v-if="saving" :size="12" class="animate-spin" />
      <ShieldCheck v-else :size="12" />
      {{ t(saving ? "projectDialog.trustSaving" : "projectDialog.trustProject") }}
    </Button>
  </span>
</template>
