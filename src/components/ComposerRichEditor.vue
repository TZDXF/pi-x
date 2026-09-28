<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from "vue"
import { usePromptInput } from "@/components/ai-elements/prompt-input/context"
import { useSessionLabels } from "@/composables/useSessionLabels"
import {
  composerChipClass,
  composerChipText,
  composerParts,
  editorSelection,
  editorText,
  setEditorCaret,
} from "@/lib/composerTokens"

defineProps<{ placeholder: string; disabled?: boolean }>()
const { textInput, setTextInput, addFiles, files, removeFile } = usePromptInput()
const sessionLabels = useSessionLabels()
const editor = ref<HTMLElement | null>(null)
const composing = ref(false)

function render(value: string, caret?: number) {
  const root = editor.value
  if (!root) return
  root.replaceChildren()
  for (const part of composerParts(value, sessionLabels.value)) {
    if (part.kind === "text") {
      root.append(document.createTextNode(part.raw))
      continue
    }
    const chip = document.createElement("span")
    chip.dataset.raw = part.raw
    chip.contentEditable = "false"
    chip.setAttribute("aria-label", part.label)
    chip.className = composerChipClass
    const label = document.createElement("span")
    label.className = "truncate"
    label.textContent = composerChipText(part)
    chip.append(label)
    root.append(chip)
  }
  if (caret !== undefined) setEditorCaret(root, caret)
}

onMounted(() => render(textInput.value))
watch(textInput, value => {
  if (composing.value || !editor.value || editorText(editor.value) === value) return
  render(value, document.activeElement === editor.value ? value.length : undefined)
})
watch(sessionLabels, () => {
  if (composing.value || !editor.value) return
  render(textInput.value, document.activeElement === editor.value ? editorSelection(editor.value).start : undefined)
})

function onInput() {
  if (composing.value || !editor.value) return
  const value = editorText(editor.value)
  const caret = editorSelection(editor.value).start
  setTextInput(value)
  render(value, caret)
}

function replaceSelection(value: string) {
  const root = editor.value
  if (!root) return
  const { start, end } = editorSelection(root)
  const next = textInput.value.slice(0, start) + value + textInput.value.slice(end)
  setTextInput(next)
  render(next, start + value.length)
  root.dispatchEvent(new Event("input", { bubbles: true }))
}

function onKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || composing.value || event.isComposing || event.keyCode === 229) return
  if ((event.key === "Backspace" || event.key === "Delete") && editor.value) {
    const { start, end } = editorSelection(editor.value)
    if (start !== end) {
      event.preventDefault()
      replaceSelection("")
      return
    }
    if (start === end) {
      let cursor = 0
      for (const part of composerParts(textInput.value, sessionLabels.value)) {
        const next = cursor + part.raw.length
        if (part.kind !== "text" && (event.key === "Backspace" ? next === start : cursor === start)) {
          event.preventDefault()
          const updated = textInput.value.slice(0, cursor) + textInput.value.slice(next)
          setTextInput(updated)
          render(updated, cursor)
          editor.value.dispatchEvent(new Event("input", { bubbles: true }))
          return
        }
        cursor = next
      }
    }
  }
  if (event.key === "Enter") {
    event.preventDefault()
    if (event.shiftKey) {
      replaceSelection("\n")
      return
    }
    const form = editor.value?.closest("form")
    if (!(form?.querySelector('button[type="submit"]') as HTMLButtonElement | null)?.disabled) form?.requestSubmit()
  }
  if (event.key === "Backspace" && !textInput.value && files.value.length) {
    event.preventDefault()
    removeFile(files.value[files.value.length - 1]!.id)
  }
}

function onPaste(event: ClipboardEvent) {
  const attachments = Array.from(event.clipboardData?.items || [])
    .filter(item => item.kind === "file")
    .map(item => item.getAsFile())
    .filter((file): file is File => !!file)
  if (attachments.length) {
    event.preventDefault()
    addFiles(attachments)
    return
  }
  event.preventDefault()
  replaceSelection(event.clipboardData?.getData("text/plain") || "")
}

function onCopy(event: ClipboardEvent) {
  if (!editor.value) return
  const { start, end } = editorSelection(editor.value)
  if (start === end) return
  event.preventDefault()
  event.clipboardData?.setData("text/plain", textInput.value.slice(start, end))
  if (event.type === "cut") replaceSelection("")
}

function onCompositionEnd() {
  composing.value = false
  nextTick(onInput)
}
</script>

<template>
  <div
    ref="editor"
    data-slot="input-group-control"
    role="textbox"
    aria-multiline="true"
    :aria-label="placeholder"
    :data-placeholder="placeholder"
    :contenteditable="disabled ? 'false' : 'true'"
    :aria-disabled="disabled"
    class="composer-rich-editor field-sizing-content max-h-48 min-h-14 w-full flex-1 overflow-y-auto whitespace-pre-wrap wrap-anywhere bg-transparent px-3 py-2 text-sm leading-[1.7] outline-none empty:before:pointer-events-none empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)] aria-disabled:opacity-50"
    @input="onInput"
    @keydown="onKeydown"
    @paste="onPaste"
    @copy="onCopy"
    @cut="onCopy"
    @compositionstart="composing = true"
    @compositionend="onCompositionEnd"
  />
</template>
