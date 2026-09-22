<script setup lang="ts">
import { isDesktop } from "@/api/transport"
import { ref } from "vue"
import { useI18n } from "vue-i18n"
import { open } from "@tauri-apps/plugin-dialog"
import { detectPi, saveConfig } from "@/api/piClient"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { AppConfig, PiInfo } from "@/api/piClient"

const props = defineProps<{
  phase: "detecting" | "no-pi" | "pick"
  config: AppConfig
}>()

const emit = defineEmits<{
  configured: []
  projectSelected: [dir: string]
}>()

const customPath = ref(props.config.piPath ?? "")
const info = ref<PiInfo | null>(null)
const busy = ref(false)
const { t } = useI18n()

async function saveAndDetect() {
  busy.value = true
  try {
    await saveConfig({ ...props.config, piPath: customPath.value || undefined })
    info.value = await detectPi(customPath.value || undefined)
    if (info.value.found) emit("configured")
  } finally {
    busy.value = false
  }
}

async function pickFolder() {
  const dir = isDesktop ? await open({ directory: true, title: t("welcome.openFolderTitle") }) : window.prompt(t("settings.remoteProject"))
  if (typeof dir === "string") emit("projectSelected", dir)
}
</script>

<template>
  <div class="flex flex-1 items-center justify-center p-8">
    <div class="w-full max-w-xl space-y-8">
      <div class="space-y-2 text-center">
        <h1 class="text-3xl font-semibold tracking-tight">Pi X</h1>
        <p class="text-muted-foreground text-sm">{{ t("welcome.subtitle") }}</p>
      </div>

      <p
        v-if="phase === 'detecting'"
        class="text-center text-sm text-muted-foreground animate-pulse"
      >
        {{ t("welcome.connecting") }}
      </p>

      <!-- pi not found: install guidance -->
      <div v-if="phase === 'no-pi'" class="space-y-4 rounded-lg border p-5">
        <div>
          <h2 class="font-medium">{{ t("welcome.noPiTitle") }}</h2>
          <p class="text-muted-foreground mt-1 text-sm">
            {{
              t("welcome.noPiDesc", {
                code: "pi --mode rpc",
              })
            }}
          </p>
        </div>
        <div
          class="bg-muted flex items-center gap-2 rounded-md px-3 py-2 font-mono text-xs"
        >
          <span class="flex-1 overflow-x-auto whitespace-nowrap"
            >npm install -g --ignore-scripts
            @earendil-works/pi-coding-agent</span
          >
        </div>
        <div class="flex gap-2">
          <Input
            v-model="customPath"
            :placeholder="t('welcome.pathPlaceholder')"
            class="h-9 flex-1"
          />
          <Button :disabled="busy" class="px-4" @click="saveAndDetect">
            {{ busy ? t("welcome.checking") : t("welcome.usePath") }}
          </Button>
        </div>
      </div>

      <!-- pi found: pick project -->
      <div v-if="phase === 'pick'" class="space-y-4 rounded-lg border p-5">
        <div class="flex items-center gap-2">
          <span class="size-2 rounded-full bg-green-500" />
          <span class="text-sm">
            Pi {{ t("welcome.ready") }}
            <span v-if="info?.version" class="text-muted-foreground"
              >({{ info.version }})</span
            >
          </span>
        </div>
        <Button
          class="h-11 w-full"
          @click="pickFolder"
        >
          {{ t("welcome.openFolder") }}
        </Button>
        <p class="text-muted-foreground text-center text-xs">
          {{ t("welcome.pickHint") }}
        </p>
      </div>
    </div>
  </div>
</template>
