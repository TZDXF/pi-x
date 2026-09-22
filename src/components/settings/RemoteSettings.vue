<script setup lang="ts">
/** Remote access page: toggle the LAN server and list connection URLs. */
import { onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { isDesktop } from "@/api/transport"
import { remoteStatus, remoteSet, type RemoteStatus } from "@/api/piClient"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { useUiStore } from "@/stores/ui"

const { t } = useI18n()
const ui = useUiStore()

const remote = ref<RemoteStatus>({ enabled: false, port: 1421, urls: [] })
const remoteBusy = ref(false)

onMounted(async () => {
  if (!isDesktop) return
  try {
    remote.value = await remoteStatus()
  } catch {
    // Keep defaults when the status cannot be loaded.
  }
})

async function toggleRemote() {
  remoteBusy.value = true
  try {
    remote.value = await remoteSet(!remote.value.enabled, Number(remote.value.port))
  } catch (e) {
    ui.pushToast(String(e), "error")
  } finally {
    remoteBusy.value = false
  }
}
</script>

<template>
  <p class="text-sm text-amber-600">{{ t("settings.remoteWarning") }}</p>
  <template v-if="isDesktop">
    <label class="block text-sm" for="remote-port">{{ t("settings.remotePort") }}</label>
    <Input
      id="remote-port"
      v-model="remote.port"
      type="number"
      min="1"
      max="65535"
      :disabled="remote.enabled || remoteBusy"
    />
    <Button
      variant="outline"
      class="h-auto px-4 py-2"
      :disabled="remoteBusy"
      :aria-pressed="remote.enabled"
      @click="toggleRemote"
    >
      {{
        remoteBusy
          ? t("settings.saving")
          : remote.enabled
            ? t("settings.remoteDisable")
            : t("settings.remoteEnable")
      }}
    </Button>
    <div v-if="remote.enabled" class="space-y-3 text-sm">
      <p>{{ t("settings.remoteLinks") }}</p>
      <Input
        v-for="url in remote.urls"
        :key="url"
        :model-value="url"
        readonly
        :aria-label="t('settings.remoteLinks')"
        class="font-mono text-xs"
        @focus="($event.target as HTMLInputElement).select()"
      />
      <p v-if="!remote.urls.length">{{ t("settings.remoteNoAddress") }}</p>
      <p class="text-muted-foreground">{{ t("settings.remoteFirewall") }}</p>
    </div>
  </template>
  <p v-else class="text-sm">{{ t("settings.remoteDesktopOnly") }}</p>
</template>
