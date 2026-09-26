<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { listGlobalPrompts, saveGlobalPrompt, type GlobalPromptFile } from "@/api/piClient"
import { useUiStore } from "@/stores/conversations"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

interface PromptDraft extends GlobalPromptFile { savedContent: string }

const { t } = useI18n()
const ui = useUiStore()
const files = ref<PromptDraft[]>([])
const selectedName = ref("SYSTEM.md")
const selectedFile = computed(() => files.value.find(file => file.fileName === selectedName.value))
const loading = ref(true)
const saving = ref(false)
const error = ref("")

async function load() {
  loading.value = true
  error.value = ""
  try {
    files.value = (await listGlobalPrompts()).map(file => ({ ...file, savedContent: file.content }))
  } catch (e) { error.value = String(e) }
  finally { loading.value = false }
}

function updatePrompt(value: string | number) {
  if (selectedFile.value) selectedFile.value.content = String(value)
}

async function save() {
  const file = selectedFile.value
  if (!file || file.content === file.savedContent) return
  saving.value = true
  try {
    await saveGlobalPrompt(file.fileName, file.content)
    file.exists = !!file.content.trim()
    file.savedContent = file.content
    ui.pushToast(t("agentConfig.saved"), "info")
  } catch (e) { ui.pushToast(String(e), "error") }
  finally { saving.value = false }
}
onMounted(load)
</script>

<template>
  <p v-if="loading" class="text-sm text-muted-foreground">{{ t("agentConfig.loading") }}</p>
  <div v-else-if="error" role="alert" class="space-y-3">
    <p class="text-sm text-destructive">{{ error }}</p>
    <Button variant="outline" @click="load">{{ t("agentConfig.retry") }}</Button>
  </div>
  <fieldset v-else :disabled="saving" class="min-w-0">
    <div class="flex min-w-0 flex-col gap-5 sm:flex-row">
      <nav :aria-label="t('agentConfig.files')" class="flex shrink-0 flex-col gap-1 sm:w-48">
        <button
          v-for="file in files"
          :key="file.fileName"
          type="button"
          :aria-pressed="selectedName === file.fileName"
          class="flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :class="selectedName === file.fileName ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground'"
          @click="selectedName = file.fileName"
        >
          <span class="min-w-0 truncate font-mono text-xs">{{ file.fileName }}</span>
          <span v-if="file.content !== file.savedContent" class="size-2 shrink-0 rounded-full bg-primary" :aria-label="t('agentConfig.unsaved')" />
        </button>
      </nav>
      <section v-if="selectedFile" class="min-w-0 flex-1 space-y-3">
        <div class="flex flex-wrap items-center gap-2">
          <label for="global-agent-prompt" class="font-mono text-sm font-medium">{{ selectedFile.fileName }}</label>
          <span class="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{{ t(selectedFile.exists ? 'agentConfig.exists' : 'agentConfig.missing') }}</span>
        </div>
        <p class="text-xs text-muted-foreground">{{ t(`agentConfig.hints.${selectedFile.fileName}`) }}</p>
        <p class="text-xs text-muted-foreground">{{ t("agentConfig.promptHint") }}</p>
        <Textarea
          id="global-agent-prompt"
          :model-value="selectedFile.content"
          class="min-h-64 font-mono text-sm"
          :placeholder="t('agentConfig.placeholder')"
          @update:model-value="updatePrompt"
        />
        <div class="flex items-center gap-3">
          <Button :disabled="saving || selectedFile.content === selectedFile.savedContent" @click="save">{{ t(saving ? "agentConfig.saving" : "agentConfig.save") }}</Button>
          <span v-if="selectedFile.content !== selectedFile.savedContent" class="text-xs text-muted-foreground">{{ t("agentConfig.unsaved") }}</span>
        </div>
      </section>
    </div>
  </fieldset>
</template>
