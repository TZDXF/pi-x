import { defineStore } from "pinia"
import { ref } from "vue"
import { getModelsConfig, saveModelsConfig, type ModelsConfig } from "@/api/piClient"

/**
 * Shared state for pi's `~/.pi/agent/models.json`, backing the provider and
 * model management tabs in Settings. Mutations are persisted immediately;
 * pi re-reads the file whenever its model picker opens, so no restart is
 * needed.
 */
/** API types supported by pi's models.json providers. */
export const PROVIDER_API_TYPES = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const

export const useModelsConfigStore = defineStore("modelsConfig", () => {
  const config = ref<ModelsConfig>({ providers: {} })
  const loaded = ref(false)
  const saving = ref(false)

  async function load(force = false) {
    if (loaded.value && !force) return
    const c = await getModelsConfig()
    config.value = { ...c, providers: c.providers ?? {} }
    loaded.value = true
  }

  /** Persist the current config; throws on IO/serialization failure. */
  async function persist() {
    saving.value = true
    try {
      await saveModelsConfig(config.value)
    } finally {
      saving.value = false
    }
  }

  return { config, loaded, saving, load, persist }
})
