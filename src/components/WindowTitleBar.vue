<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { isDesktop } from "@/api/transport"

const { t } = useI18n()
const appWindow = isDesktop ? getCurrentWindow() : null
const maximized = ref(false)
const maximizable = ref(true)
let unlistenResized: (() => void) | null = null

async function refreshWindowState() {
  if (!appWindow) return
  const [isMaximized, canMaximize] = await Promise.all([appWindow.isMaximized(), appWindow.isMaximizable()])
  maximized.value = isMaximized
  maximizable.value = canMaximize
}

onMounted(async () => {
  if (!appWindow) return
  unlistenResized = await appWindow.onResized(refreshWindowState)
  await refreshWindowState()
})

onUnmounted(() => {
  unlistenResized?.()
  unlistenResized = null
})

function minimize() {
  void appWindow?.minimize()
}

function toggleMaximize() {
  void appWindow?.toggleMaximize()
}

function close() {
  void appWindow?.close()
}
</script>

<template>
  <header
    v-if="isDesktop"
    data-testid="window-titlebar"
    class="fixed inset-x-0 top-0 z-[200] flex h-9 select-none items-center bg-background text-foreground shadow-[0_1px_0_var(--border)]"
  >
    <div
      data-tauri-drag-region
      class="flex h-full min-w-0 flex-1 items-center gap-2 px-3"
      title="PiX"
      @dblclick="toggleMaximize"
    >
      <span data-tauri-drag-region class="text-sm font-semibold">PiX</span>
    </div>
    <div class="flex h-full items-center">
      <button
        type="button"
        class="titlebar-control"
        :title="t('app.windowMinimize')"
        :aria-label="t('app.windowMinimize')"
        @click="minimize"
      >
        <svg aria-hidden="true" viewBox="0 0 10 10" class="size-2.5">
          <path d="M0 5h10" stroke="currentColor" stroke-width="1" />
        </svg>
      </button>
      <button
        v-if="maximizable"
        type="button"
        class="titlebar-control"
        :title="maximized ? t('app.windowRestore') : t('app.windowMaximize')"
        :aria-label="maximized ? t('app.windowRestore') : t('app.windowMaximize')"
        @click="toggleMaximize"
      >
        <svg v-if="maximized" aria-hidden="true" viewBox="0 0 10 10" class="size-2.5">
          <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" stroke-width="1" fill="none" />
          <path d="M2.5 2.5V0.5h7v7h-2" stroke="currentColor" stroke-width="1" fill="none" />
        </svg>
        <svg v-else aria-hidden="true" viewBox="0 0 10 10" class="size-2.5">
          <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" stroke-width="1" fill="none" />
        </svg>
      </button>
      <button
        type="button"
        class="titlebar-control titlebar-close"
        :title="t('app.windowClose')"
        :aria-label="t('app.windowClose')"
        @click="close"
      >
        <svg aria-hidden="true" viewBox="0 0 10 10" class="size-2.5">
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" stroke-width="1" />
        </svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.titlebar-control {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 100%;
  color: var(--muted-foreground);
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}
.titlebar-control:hover {
  background: var(--accent);
  color: var(--accent-foreground);
}
.titlebar-control:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -3px;
}
.titlebar-close:hover {
  background: #e81123;
  color: #fff;
}
</style>
