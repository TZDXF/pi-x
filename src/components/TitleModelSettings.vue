<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { getConfig, saveConfig, getModelsConfig } from "@/api/piClient"
import { useSessionStore } from "@/stores/session"
import { useUiStore } from "@/stores/ui"
import ConversationModelSelect from "./ConversationModelSelect.vue"
const { t } = useI18n()
const session = useSessionStore()
const ui = useUiStore()
const enabled = ref(false)
const followMain = ref(false)
const provider = ref("")
const modelId = ref("")
const defaultFollowMain = ref(true)
const defaultProvider = ref("")
const defaultModelId = ref("")
const loading = ref(true)
const saving = ref(false)
const loadError = ref(false)
const customModels = ref<{ provider: string; id: string; name?: string }[]>([])
const models = computed(() => {
  // Use exactly the conversation list when pi is running; custom models remain
  // selectable from settings before opening a project.
  const available = session.models.length ? session.models : customModels.value
  const saved = [
    { provider: provider.value, id: modelId.value },
    { provider: defaultProvider.value, id: defaultModelId.value },
  ].filter(m => m.provider && m.id && !available.some(a => a.provider === m.provider && a.id === m.id))
  return saved.length ? [...available, ...saved] : available
})
function splitKey(key: string): [string, string] | null {
  const separator = key.indexOf("/")
  if (separator < 1) return null
  return [key.slice(0, separator), key.slice(separator + 1)]
}
const modelKey = computed({
  get: () => provider.value && modelId.value ? `${provider.value}/${modelId.value}` : "",
  set: (key: string) => {
    const parts = splitKey(key)
    if (!parts) return
    provider.value = parts[0]
    modelId.value = parts[1]
  },
})
const defaultKey = computed({
  get: () => defaultProvider.value && defaultModelId.value ? `${defaultProvider.value}/${defaultModelId.value}` : "",
  set: (key: string) => {
    const parts = splitKey(key)
    if (!parts) return
    defaultFollowMain.value = false
    defaultProvider.value = parts[0]
    defaultModelId.value = parts[1]
  },
})
onMounted(async () => {
  try {
    const config = await getConfig()
    followMain.value = !!config.titleFollowMain
    enabled.value = !!config.titleModel || followMain.value
    provider.value = config.titleModel?.provider ?? ""
    modelId.value = config.titleModel?.modelId ?? ""
    defaultFollowMain.value = !config.defaultModel
    defaultProvider.value = config.defaultModel?.provider ?? ""
    defaultModelId.value = config.defaultModel?.modelId ?? ""
    try {
      const custom = await getModelsConfig()
      customModels.value = Object.entries(custom.providers).flatMap(([provider, entry]) => (entry.models ?? []).map(m => ({ provider, id: m.id, name: m.name })))
    } catch { /* Runtime models and the saved selection remain available. */ }
  } catch (e) { loadError.value = true; ui.pushToast(String(e), "error") }
  finally { loading.value = false }
})
async function save() {
  const customValid = !!provider.value.trim() && !!modelId.value.trim()
  if (saving.value || loadError.value || (enabled.value && !followMain.value && !customValid)) return
  saving.value = true
  try {
    const config = await getConfig()
    // Keep the custom title model while following main so toggling back restores it.
    await saveConfig({
      ...config,
      defaultModel: !defaultFollowMain.value && defaultProvider.value.trim() && defaultModelId.value.trim()
        ? { provider: defaultProvider.value.trim(), modelId: defaultModelId.value.trim() }
        : undefined,
      titleModel: enabled.value && customValid
        ? { provider: provider.value.trim(), modelId: modelId.value.trim() }
        : undefined,
      titleFollowMain: enabled.value && followMain.value ? true : undefined,
    })
    ui.pushToast(t("settings.toastSaved"), "info")
  } catch (e) { ui.pushToast(String(e), "error") }
  finally { saving.value = false }
}
</script>
<template>
  <form class="space-y-4" @submit.prevent="save">
    <fieldset :disabled="loading || saving || loadError" class="space-y-4">
      <div>
        <label for="default-model" class="mb-1 block text-sm">{{ t('titleGeneration.defaultModel') }}</label>
        <label class="mb-2 flex items-center gap-2 text-xs"><input v-model="defaultFollowMain" type="checkbox" />{{ t('titleGeneration.followMain') }}</label>
        <p v-if="defaultFollowMain" class="text-muted-foreground text-xs">{{ t('titleGeneration.defaultFollowMainHint') }}</p>
        <ConversationModelSelect v-else id="default-model" v-model="defaultKey" :models="models"
          :disabled="loading || saving || loadError || !models.length" trigger-class="h-8 w-full text-xs" />
        <p class="text-muted-foreground mt-1 text-xs">{{ t('titleGeneration.defaultModelHint') }}</p>
        <p v-if="!loading && !models.length" class="text-muted-foreground mt-1 text-xs">{{ t('titleGeneration.noModels') }}</p>
      </div>
      <label class="flex items-center gap-2 text-sm"><input v-model="enabled" type="checkbox" />{{ t('titleGeneration.enabled') }}</label>
      <p class="text-muted-foreground text-xs">{{ t('titleGeneration.hint') }}</p>
      <template v-if="enabled">
        <div>
          <label for="title-model" class="mb-1 block text-sm">{{ t('titleGeneration.model') }}</label>
          <label class="mb-2 flex items-center gap-2 text-xs"><input v-model="followMain" type="checkbox" />{{ t('titleGeneration.followMain') }}</label>
          <p v-if="followMain" class="text-muted-foreground text-xs">{{ t('titleGeneration.followMainHint') }}</p>
          <template v-else>
            <ConversationModelSelect id="title-model" v-model="modelKey" :models="models"
              :disabled="loading || saving || loadError || !models.length" trigger-class="h-8 w-full text-xs" />
            <p class="text-muted-foreground mt-2 text-xs">{{ t('titleGeneration.credentials') }}</p>
          </template>
        </div>
      </template>
      <button class="bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-xs" type="submit" :disabled="enabled && !followMain && (!provider.trim() || !modelId.trim())">{{ saving ? t('settings.saving') : t('settings.save') }}</button>
    </fieldset>
  </form>
</template>