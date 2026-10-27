<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import { LoaderCircle } from "@lucide/vue"
import type { DeployStatus } from "@/api/piClient"
import type { SshDeployProgress } from "@/composables/useSshDeployProgress"
import { Button } from "@/components/ui/button"

const props = defineProps<{
  status?: DeployStatus | null
  deploying: boolean
  progress?: SshDeployProgress | null
}>()
const emit = defineEmits<{ deploy: [] }>()
const { t } = useI18n()
const label = computed(() => {
  if (!props.status) return ""
  if (!props.status.piFound) return t("ssh.piNotDeployed")
  return props.status.deployed ? t("ssh.piDeployed") : t("ssh.piInPATH")
})
</script>

<template>
  <div v-if="status || (deploying && progress)">
    <div v-if="status" class="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs">
      <span class="text-muted-foreground">{{ t("ssh.deployStatus") }}:</span>
      <span :class="status.piFound ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'">
        {{ label }}
      </span>
      <span v-if="status.version" class="text-muted-foreground">{{ status.version }}</span>
      <Button
        v-if="!status.piFound"
        variant="ghost"
        size="sm"
        class="ms-auto h-6 px-2 text-xs"
        :disabled="deploying"
        @click="emit('deploy')"
      >
        <LoaderCircle v-if="deploying" :size="12" class="animate-spin" />
        {{ t("ssh.deploy") }}
      </Button>
    </div>
    <div
      v-if="deploying && progress"
      class="rounded-md border border-border px-2 py-2 text-xs"
      :class="{ 'mt-2': status }"
    >
      <div class="flex items-center gap-2">
        <LoaderCircle :size="12" class="animate-spin text-muted-foreground" />
        <span class="text-muted-foreground">{{ progress.message }}</span>
        <span class="ms-auto text-muted-foreground">{{ progress.percent }}%</span>
      </div>
      <div class="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
        <div
          class="h-full rounded-full bg-blue-500 transition-all duration-300"
          :style="{ width: `${progress.percent}%` }"
        />
      </div>
    </div>
  </div>
</template>
