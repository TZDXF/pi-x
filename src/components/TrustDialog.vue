<script setup lang="ts">
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import { Button } from "@/components/ui/button"
import type { TrustStatus } from "@/api/piClient"

const props = defineProps<{ info: TrustStatus }>()

const emit = defineEmits<{
  done: [trusted: boolean, trustParent: boolean]
}>()

const busy = ref(false)
const { t } = useI18n()

function decide(trusted: boolean, trustParent = false) {
  busy.value = true
  emit("done", trusted, trustParent)
}
</script>

<template>
  <div class="bg-card w-full max-w-lg space-y-5 rounded-xl border p-6 shadow-lg">
    <div class="space-y-1">
      <h2 class="text-lg font-semibold">{{ t("trust.title") }}</h2>
      <p class="text-muted-foreground text-sm">
        <span class="text-foreground font-mono">{{ props.info.projectPath }}</span>
        {{ t("trust.desc") }}
        <span class="text-muted-foreground">{{ t("trust.descDetail") }}</span>
      </p>
    </div>

    <div class="border-amber-500/40 bg-amber-50 dark:bg-amber-950/40 rounded-md border p-3 text-sm">
      {{ t("trust.warning") }}
    </div>

    <div class="flex flex-col gap-2">
      <Button :disabled="busy" class="py-2.5" @click="decide(true)">
        {{ t("trust.trustFolder") }}
      </Button>
      <Button
        v-if="props.info.parentPath"
        :disabled="busy"
        variant="outline"
        class="py-2.5"
        @click="decide(true, true)"
      >
        {{ t("trust.trustParent") }}
        <span class="text-muted-foreground font-mono text-xs">({{ props.info.parentPath }})</span>
      </Button>
      <Button :disabled="busy" variant="outline" class="py-2.5" @click="decide(false)">
        {{ t("trust.dontTrust") }}
        <span class="text-muted-foreground text-xs">{{ t("trust.dontTrustNote") }}</span>
      </Button>
    </div>

    <p class="text-muted-foreground text-xs">
      {{ t("trust.note") }}
    </p>
  </div>
</template>
