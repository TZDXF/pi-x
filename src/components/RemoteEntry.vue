<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import App from "@/App.vue"
import { hasRemoteToken, isDesktop, loginRemote, remoteAuthStatus, REMOTE_UNAUTHORIZED_EVENT } from "@/api/transport"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

const { t } = useI18n()
// Browser-only Vite previews have no remote auth server; keep local development usable.
const bypassAuth = isDesktop || import.meta.env.DEV
const authenticated = ref(bypassAuth)
const loading = ref(!bypassAuth)
const passwordEnabled = ref(false)
const password = ref("")
const error = ref("")

function unauthorized() {
  authenticated.value = false
}
onMounted(async () => {
  if (bypassAuth) return
  window.addEventListener(REMOTE_UNAUTHORIZED_EVENT, unauthorized)
  try {
    const status = await remoteAuthStatus()
    passwordEnabled.value = status.passwordEnabled
    authenticated.value = status.authenticated && hasRemoteToken()
  } catch {
    error.value = t("settings.remoteLoginUnavailable")
  } finally {
    loading.value = false
  }
})
onUnmounted(() => window.removeEventListener(REMOTE_UNAUTHORIZED_EVENT, unauthorized))

async function login() {
  if (loading.value || !password.value) return
  loading.value = true
  error.value = ""
  try {
    const result = await loginRemote(password.value)
    if (result === "ok") {
      password.value = ""
      authenticated.value = true
    } else {
      error.value = t(result === "limited" ? "settings.remoteLoginLimited" : "settings.remoteLoginInvalid")
    }
  } catch {
    error.value = t("settings.remoteLoginUnavailable")
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <App v-if="authenticated" />
  <main v-else class="flex min-h-[100dvh] items-center justify-center bg-background p-5 text-foreground">
    <div class="w-full max-w-sm space-y-5 rounded-xl border border-border bg-card p-6 shadow-sm">
      <div class="space-y-1">
        <h1 class="text-lg font-semibold">{{ t("settings.remoteLoginTitle") }}</h1>
        <p class="text-sm text-muted-foreground">{{ t("settings.remoteLoginDesc") }}</p>
      </div>
      <form v-if="passwordEnabled" class="space-y-3" @submit.prevent="login">
        <label class="block text-sm font-medium" for="remote-login-password">{{ t("settings.remotePassword") }}</label>
        <Input
          id="remote-login-password"
          v-model="password"
          type="password"
          autocomplete="current-password"
          autofocus
          required
        />
        <Button type="submit" class="w-full" :disabled="loading || !password">{{ t("settings.remoteLogin") }}</Button>
      </form>
      <p v-else-if="!loading && !error" class="text-sm text-muted-foreground">{{ t("settings.remoteLoginQrOnly") }}</p>
      <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
    </div>
  </main>
</template>
