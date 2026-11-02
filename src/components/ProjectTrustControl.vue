<script setup lang="ts">
import { LoaderCircle, ShieldCheck } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import { trustStatus, trustSave, sshTrustStatus, sshTrustSave } from "@/api/piClient"
import { Button } from "@/components/ui/button"
import { useProjectTrust } from "@/composables/useProjectTrust"
import type { SshConnectionRef } from "@/lib/ssh"
import { tBackendError } from "@/i18n"

const props = defineProps<{ project: string; active: boolean; connections: readonly SshConnectionRef[] }>()
const { t } = useI18n()
const { status, loading, saving, saved, error, trusted, refresh, trust } = useProjectTrust({
  project: () => props.project,
  active: () => props.active,
  connections: () => props.connections,
  api: { trustStatus, trustSave, sshTrustStatus, sshTrustSave },
})
</script>

<template>
  <div class="space-y-2 rounded-md border p-3 text-sm">
    <div class="flex items-center justify-between gap-3">
      <span class="font-medium">{{ t("projectDialog.trustTitle") }}</span>
      <span v-if="loading" role="status" class="text-xs text-muted-foreground">
        {{ t("projectDialog.trustLoading") }}
      </span>
      <span v-else-if="status" role="status" class="text-xs text-muted-foreground">
        {{ t(trusted ? "projectDialog.trusted" : "projectDialog.untrusted") }}
      </span>
    </div>
    <p class="truncate text-xs text-muted-foreground" :title="project">{{ project }}</p>
    <template v-if="status && !trusted && !loading">
      <p class="text-xs text-muted-foreground">
        {{ t(status.hasTrustRequiringResources ? "trust.warning" : "trust.warningEmpty") }}
      </p>
      <Button type="button" variant="outline" size="sm" :disabled="saving" @click="trust">
        <LoaderCircle v-if="saving" :size="14" class="animate-spin" />
        <ShieldCheck v-else :size="14" />
        {{ t(saving ? "projectDialog.trustSaving" : "projectDialog.trustProject") }}
      </Button>
    </template>
    <p v-if="saved" role="status" class="text-xs text-muted-foreground">
      {{ t("projectDialog.trustSaved") }}
    </p>
    <div v-if="error" class="space-y-2">
      <p role="alert" class="text-xs text-destructive">{{ tBackendError(error) }}</p>
      <Button type="button" variant="outline" size="sm" :disabled="loading || saving" @click="refresh">
        {{ t("common.retry") }}
      </Button>
    </div>
  </div>
</template>
