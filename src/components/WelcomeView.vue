<script setup lang="ts">
import PiXLogo from "@/components/PiXLogo.vue"
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import { MessagesSquare } from "@lucide/vue"
import { detectPi, saveConfig } from "@/api/piClient"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { AppConfig } from "@/api/piClient"

const props = defineProps<{
  phase: "detecting" | "no-pi" | "pick"
  config: AppConfig
}>()

const emit = defineEmits<{
  configured: []
  openProject: []
  openProjectless: []
}>()

const customPath = ref(props.config.piPath ?? "")
const busy = ref(false)
const { t } = useI18n()

async function saveAndDetect() {
  busy.value = true
  try {
    await saveConfig({ ...props.config, piPath: customPath.value || undefined })
    const detected = await detectPi(customPath.value || undefined)
    if (detected.found) emit("configured")
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex flex-1 items-center justify-center p-8">
    <div class="w-full max-w-sm space-y-8">
      <div class="text-center">
        <h1 class="flex justify-center"><PiXLogo style="width: 120px; height: 56px" /></h1>
      </div>

      <p v-if="phase === 'detecting'" class="text-center text-sm text-muted-foreground animate-pulse">
        {{ t("welcome.connecting") }}
      </p>

      <!-- pi not found -->
      <div v-if="phase === 'no-pi'" class="space-y-4">
        <h2 class="text-center font-medium">{{ t("welcome.noPiTitle") }}</h2>
        <div class="bg-muted rounded-md px-3 py-2 font-mono text-xs">
          <span class="block whitespace-pre-wrap break-words"
            >npm install -g --ignore-scripts @earendil-works/pi-coding-agent</span
          >
        </div>
        <div class="flex gap-2">
          <Input v-model="customPath" :placeholder="t('welcome.pathPlaceholder')" class="h-9 flex-1" />
          <Button :disabled="busy" class="px-4" @click="saveAndDetect">
            {{ busy ? t("welcome.checking") : t("welcome.usePath") }}
          </Button>
        </div>
      </div>

      <!-- pi found -->
      <div v-if="phase === 'pick'" class="space-y-3">
        <Button class="h-11 w-full" @click="emit('openProject')">
          {{ t("welcome.openFolder") }}
        </Button>
        <Button variant="outline" class="h-11 w-full" @click="emit('openProjectless')">
          <MessagesSquare :size="16" class="size-auto shrink-0" />
          {{ t("projectless.name") }}
        </Button>
      </div>
    </div>
  </div>
</template>
