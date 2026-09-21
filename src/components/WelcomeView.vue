<script setup lang="ts">
import { ref } from "vue"
import { open } from "@tauri-apps/plugin-dialog"
import { detectPi, saveConfig } from "@/api/piClient"
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
  const dir = await open({ directory: true, title: "Open a project folder" })
  if (typeof dir === "string") emit("projectSelected", dir)
}
</script>

<template>
  <div class="flex flex-1 items-center justify-center p-8">
    <div class="w-full max-w-xl space-y-8">
      <div class="space-y-2 text-center">
        <h1 class="text-3xl font-semibold tracking-tight">Pi X</h1>
        <p class="text-muted-foreground text-sm">你的本地 AI 编程工作区</p>
      </div>

      <p
        v-if="phase === 'detecting'"
        class="text-center text-sm text-muted-foreground animate-pulse"
      >
        正在连接本地运行环境…
      </p>

      <!-- pi not found: install guidance -->
      <div v-if="phase === 'no-pi'" class="space-y-4 rounded-lg border p-5">
        <div>
          <h2 class="font-medium">pi CLI not found</h2>
          <p class="text-muted-foreground mt-1 text-sm">
            Pi X drives
            <code class="bg-muted rounded px-1">pi --mode rpc</code> as a child
            process. Install the pi CLI (requires Node.js), or point Pi X at an
            existing binary below.
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
          <input
            v-model="customPath"
            placeholder="Custom pi path, e.g. C:\Users\you\AppData\Roaming\npm\pi.cmd"
            class="border-input ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring h-9 flex-1 rounded-md border bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2"
          />
          <button
            :disabled="busy"
            class="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-4 text-sm disabled:opacity-50"
            @click="saveAndDetect"
          >
            {{ busy ? "Checking…" : "Use this path" }}
          </button>
        </div>
      </div>

      <!-- pi found: pick project -->
      <div v-if="phase === 'pick'" class="space-y-4 rounded-lg border p-5">
        <div class="flex items-center gap-2">
          <span class="size-2 rounded-full bg-green-500" />
          <span class="text-sm">
            Pi 已就绪
            <span v-if="info?.version" class="text-muted-foreground"
              >({{ info.version }})</span
            >
          </span>
        </div>
        <button
          class="bg-primary text-primary-foreground hover:bg-primary/90 w-full rounded-md py-3 text-sm font-medium"
          @click="pickFolder"
        >
          打开项目文件夹…
        </button>
        <p class="text-muted-foreground text-center text-xs">
          选择一个项目，开始探索代码或构建新的想法。
        </p>
      </div>
    </div>
  </div>
</template>
