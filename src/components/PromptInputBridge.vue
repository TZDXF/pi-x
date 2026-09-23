<script setup lang="ts">
/**
 * Invisible helper rendered inside <PromptInput>.
 *
 * The PromptInput context (textInput / setTextInput / submitForm) can only be
 * injected by descendant components, but ChatView needs programmatic access
 * (extensions pushing editor text, Esc-restore, status computation).
 * This bridge exposes the context to the parent via a template ref.
 *
 * Do NOT bind :value/@input on <PromptInputTextarea> — the context is the
 * single source of truth and external value bindings fight the v-model DOM
 * updates during IME composition (typed characters get truncated).
 */
import { usePromptInput } from "@/components/ai-elements/prompt-input/context"

const { textInput, setTextInput, submitForm, files, addFiles, removeFile, openFileDialog } = usePromptInput()

defineExpose({ textInput, setTextInput, submitForm, files, addFiles, removeFile, openFileDialog })
</script>

<template>
  <span class="hidden" aria-hidden="true" />
</template>
