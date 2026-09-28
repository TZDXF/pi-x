<script setup lang="ts">
/** Remote access page: toggle the LAN server and share connection URLs via QR codes. */
import { onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { Copy } from "@lucide/vue"
import { QrcodeSvg } from "qrcode.vue"
import { isDesktop } from "@/api/transport"
import { remoteStatus, remoteSet, remotePasswordSet, type RemoteStatus } from "@/api/piClient"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { useUiStore } from "@/stores/conversations"

const { t } = useI18n()
const ui = useUiStore()

const remote = ref<RemoteStatus>({ enabled: false, port: 1421, urls: [], passwordEnabled: false })
const remoteBusy = ref(false)
const password = ref("")

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

async function savePassword(value: string | null) {
  remoteBusy.value = true
  try {
    remote.value = await remotePasswordSet(value)
    password.value = ""
    ui.pushToast(t("settings.remotePasswordSaved"), "info")
  } catch (e) {
    ui.pushToast(String(e), "error")
  } finally {
    remoteBusy.value = false
  }
}

async function copyLink(url: string) {
  try {
    await navigator.clipboard.writeText(url)
    ui.pushToast(t("settings.remoteLinkCopied"), "info")
  } catch (e) {
    ui.pushToast(String(e), "error")
  }
}
</script>

<template>
  <template v-if="isDesktop">
    <div class="space-y-5">
      <div class="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-muted/30 p-4">
        <div class="min-w-32 flex-1 space-y-2">
          <label class="block text-sm font-medium" for="remote-port">{{ t("settings.remotePort") }}</label>
          <Input
            id="remote-port"
            v-model="remote.port"
            type="number"
            min="1"
            max="65535"
            :disabled="remote.enabled || remoteBusy"
            class="w-32 bg-background"
          />
        </div>
        <Button
          :variant="remote.enabled ? 'outline' : 'default'"
          class="h-9 px-4"
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
      </div>

      <div class="space-y-3 rounded-xl border border-border p-4">
        <div class="flex items-center justify-between gap-3">
          <label v-if="!remote.enabled" class="text-sm font-medium" for="remote-password">{{
            t("settings.remotePassword")
          }}</label>
          <span v-else class="text-sm font-medium">{{ t("settings.remotePassword") }}</span>
          <span v-if="remote.passwordEnabled" class="text-xs text-muted-foreground">{{
            t("settings.remotePasswordConfigured")
          }}</span>
        </div>
        <form v-if="!remote.enabled" class="flex flex-wrap gap-2" @submit.prevent="savePassword(password)">
          <Input
            id="remote-password"
            v-model="password"
            type="password"
            autocomplete="new-password"
            :placeholder="t('settings.remotePasswordPlaceholder')"
            class="min-w-40 flex-1"
          />
          <Button type="submit" variant="outline" :disabled="remoteBusy || password.length < 8">{{
            t("settings.remotePasswordSave")
          }}</Button>
          <Button
            v-if="remote.passwordEnabled"
            type="button"
            variant="ghost"
            :disabled="remoteBusy"
            @click="savePassword(null)"
            >{{ t("settings.remotePasswordClear") }}</Button
          >
        </form>
        <p v-else class="text-xs text-muted-foreground">{{ t("settings.remotePasswordChangeHint") }}</p>
      </div>

      <div v-if="remote.enabled" class="space-y-3">
        <h3 class="text-sm font-medium">{{ t("settings.remoteLinks") }}</h3>
        <div v-if="remote.urls.length" class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-3">
          <div
            v-for="(url, index) in remote.urls"
            :key="url"
            class="flex flex-col items-center gap-3 rounded-xl border border-border bg-card p-4"
          >
            <span class="self-start text-xs font-medium text-muted-foreground">
              {{ t("settings.remoteAddress", { number: index + 1 }) }}
            </span>
            <div
              class="rounded-lg bg-white p-3"
              role="img"
              :aria-label="t('settings.remoteQrLabel', { number: index + 1 })"
            >
              <QrcodeSvg :value="url" :size="180" level="M" />
            </div>
            <Button variant="outline" size="sm" class="w-full" @click="copyLink(url)">
              <Copy class="size-3.5" />
              {{ t("settings.remoteCopyLink") }}
            </Button>
          </div>
        </div>
        <p v-else class="text-sm text-muted-foreground">{{ t("settings.remoteNoAddress") }}</p>
      </div>
      <p class="text-xs leading-relaxed text-amber-700 dark:text-amber-400">
        {{ t(remote.passwordEnabled ? "settings.remotePasswordWarning" : "settings.remoteWarning") }}
      </p>
    </div>
  </template>
  <p v-else class="text-sm">{{ t("settings.remoteDesktopOnly") }}</p>
</template>
