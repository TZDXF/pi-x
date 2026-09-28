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

function appendText(root: HTMLElement, raw: string) {
  raw.split("\n").forEach((line, index) => {
    if (index > 0) root.append(document.createElement("br"))
    if (line) root.append(document.createTextNode(line))
  })
}

function render(value: string, caret?: number) {
  const root = editor.value
  if (!root) return
  root.replaceChildren()
  for (const part of composerParts(value, sessionLabels.value)) {
    if (part.kind === "text") {
      appendText(root, part.raw)
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
  if (value) {
    // The sentinel keeps a visible caret line after a trailing newline without adding model text.
    const caretBreak = document.createElement("br")
    caretBreak.dataset.editorCaret = ""
    root.append(caretBreak)
  }
  if (caret !== undefined) setEditorCaret(root, caret)
}

function editorRequiresRender(root: HTMLElement, value: string): boolean {
  if (editorText(root) !== value) return true
  const expected = composerParts(value, sessionLabels.value).filter(part => part.kind !== "text")
  const actual = Array.from(root.querySelectorAll<HTMLElement>("[data-raw]"))
  return expected.length !== actual.length || expected.some((part, index) => part.raw !== actual[index]?.dataset.raw)
}

onMounted(() => render(textInput.value))
watch(textInput, value => {
  if (composing.value || !editor.value || !editorRequiresRender(editor.value, value)) return
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
  // Native edits keep their undo history; only normalize when chips or DOM structure changed.
  if (editorRequiresRender(editor.value, value)) render(value, caret)
}

function insertAtSelection(value: string, lineBreak = false): boolean {
  if (lineBreak) return document.execCommand("insertLineBreak")
  if (!value) return true
  return document.execCommand("insertText", false, value)
}

function deleteAtomicChip(key: string, caret: number): boolean {
  const root = editor.value
  if (!root) return false
  const parts = composerParts(textInput.value, sessionLabels.value)
  let cursor = 0
  let chipIndex = -1
  let targetIndex = -1
  let targetCursor = 0
  let targetEnd = 0
  for (const part of parts) {
    const next = cursor + part.raw.length
    if (part.kind !== "text") {
      chipIndex++
      if ((key === "Backspace" && next === caret) || (key === "Delete" && cursor === caret)) {
        targetIndex = chipIndex
        targetCursor = cursor
        targetEnd = next
      }
    }
    cursor = next
  }
  if (targetIndex < 0) return false
  const chip = Array.from(root.querySelectorAll<HTMLElement>("[data-raw]"))[targetIndex]
  if (!chip) return false
  const range = document.createRange()
  range.selectNode(chip)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  if (document.execCommand("delete")) return true
  const updated = textInput.value.slice(0, targetCursor) + textInput.value.slice(targetEnd)
  setTextInput(updated)
  render(updated, targetCursor)
  root.dispatchEvent(new Event("input", { bubbles: true }))
  return true
}

function onKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented || composing.value || event.isComposing || event.keyCode === 229) return
  if ((event.key === "Backspace" || event.key === "Delete") && editor.value) {
    const { start, end } = editorSelection(editor.value)
    if (start === end && deleteAtomicChip(event.key, start)) return
    // Leave ordinary text deletion to the browser so native undo remains intact.
  }
  if (event.key === "Enter") {
    event.preventDefault()
    if (event.shiftKey) {
      insertAtSelection("\n", true)
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
  insertAtSelection(event.clipboardData?.getData("text/plain") || "")
}

function onCopy(event: ClipboardEvent) {
  if (!editor.value) return
  const { start, end } = editorSelection(editor.value)
  if (start === end) return
  event.preventDefault()
  event.clipboardData?.setData("text/plain", textInput.value.slice(start, end))
  if (event.type === "cut") document.execCommand("delete")
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
