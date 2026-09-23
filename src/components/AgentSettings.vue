<script setup lang="ts">
import { onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { getGlobalPrompt, saveGlobalPrompt } from "@/api/piClient"
import { useUiStore } from "@/stores/conversations"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

const { t } = useI18n()
const ui = useUiStore()
const prompt = ref("")
const loading = ref(true)
const saving = ref(false)
const error = ref("")
const dirty = ref(false)
async function load() {
  loading.value = true
  error.value = ""
  try {
    prompt.value = await getGlobalPrompt()
    dirty.value = false
  } catch (e) { error.value = String(e) }
  finally { loading.value = false }
}
async function save() {
  saving.value = true
  try {
    await saveGlobalPrompt(prompt.value)
    dirty.value = false
    ui.pushToast(t("agentConfig.saved"), "info")
  } catch (e) { ui.pushToast(String(e), "error") }
  finally { saving.value = false }
}
onMounted(load)
</script>

<template>
  <header class="flex flex-col gap-2 text-left">
    <h2 class="text-base leading-none font-medium">{{ t("agentConfig.title") }}</h2>
    <p class="text-sm text-muted-foreground">{{ t("agentConfig.description") }}</p>
  </header>
  <p v-if="loading" class="text-sm text-muted-foreground">{{ t("agentConfig.loading") }}</p>
  <div v-else-if="error" role="alert" class="space-y-3">
    <p class="text-sm text-destructive">{{ error }}</p>
    <Button variant="outline" @click="load">{{ t("agentConfig.retry") }}</Button>
  </div>
  <fieldset v-else :disabled="saving" class="min-w-0 space-y-6">
    <section class="space-y-3">
      <label for="global-agent-prompt" class="text-sm font-medium">{{ t("agentConfig.prompt") }}</label>
      <p class="text-xs text-muted-foreground">{{ t("agentConfig.promptHint") }}</p>
      <Textarea id="global-agent-prompt" v-model="prompt" class="min-h-52 font-mono text-sm" :placeholder="t('agentConfig.placeholder')" @update:model-value="dirty = true" />
    </section>
    <div class="flex items-center gap-3">
      <Button :disabled="saving || !dirty" @click="save">{{ t(saving ? "agentConfig.saving" : "agentConfig.save") }}</Button>
      <span v-if="dirty" class="text-xs text-muted-foreground">{{ t("agentConfig.unsaved") }}</span>
    </div>
  </fieldset>
</template>
