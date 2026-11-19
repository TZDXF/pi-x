import { expect, test, vi } from "vitest"
import { readFileSync } from "node:fs"
import { appendComposerText } from "@/lib/composer"
import { formatCodeCommentForComposer } from "@/lib/codeComments"
import { useCodeCommentInsertion } from "@/composables/useCodeCommentInsertion"
import { useCodeCommentsStore } from "@/stores/codeComments"
import { createPinia, setActivePinia } from "pinia"
import { ref } from "vue"
import type PromptInputBridge from "@/components/PromptInputBridge.vue"

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

test("context insertion preserves the draft and separates blocks without adding blank lines", () => {
  expect(appendComposerText("", "first")).toBe("first")
  expect(appendComposerText("existing", "annotation")).toBe("existing\n\nannotation")
  expect(appendComposerText("existing\n", "annotation")).toBe("existing\n\nannotation")
})

test("project files and history previews reach the composer before consuming a chip", () => {
  const preview = read("../src/components/ProjectFilePreview.vue")
  const files = read("../src/components/ProjectFiles.vue")
  const sidebar = read("../src/components/RightSidebar.vue")
  const historyPreview = read("../src/components/chat/CodeCommentPreview.vue")
  const turns = read("../src/components/chat/ChatTurnList.vue")
  const chat = read("../src/components/ChatView.vue")

  expect(preview).toContain('emit("insert-code-comment", comment)')
  expect(files).toMatch(/<ProjectFilePreview[\s\S]*?@insert-code-comment="emit\('insert-code-comment', \$event\)"/)
  expect(sidebar).toMatch(/<ProjectFiles[\s\S]*?@insert-code-comment="\$emit\('insert-code-comment', \$event\)"/)
  expect(historyPreview).toMatch(
    /<ProjectFilePreview[\s\S]*?@insert-code-comment="emit\('insert-code-comment', \$event\)"/,
  )
  expect(turns).toMatch(/<CodeCommentPreview[\s\S]*?@insert-code-comment="emit\('insert-code-comment', \$event\)"/)
  expect(chat.match(/@insert-code-comment="insertCodeCommentIntoComposer"/g)).toHaveLength(2)
})

test("composer insertion preserves drafts and consumes a chip only after a successful write", () => {
  setActivePinia(createPinia())
  const store = useCodeCommentsStore()
  store.add("repo", {
    path: "src/a.ts",
    root: "C:/shared",
    startLine: 2,
    endLine: 3,
    selectedText: "const a = 1",
    comment: "explain this",
  })
  const bridge = ref<InstanceType<typeof PromptInputBridge> | null>(null)
  const { insertCodeComment } = useCodeCommentInsertion(bridge)
  const pending = store.comments[0]

  insertCodeComment(pending)
  expect(store.comments).toHaveLength(1)

  const setTextInput = vi.fn((text: string) => {
    if (bridge.value) bridge.value.textInput = text
  })
  bridge.value = { textInput: "Existing draft", setTextInput } as InstanceType<typeof PromptInputBridge>
  insertCodeComment(pending)
  expect(setTextInput).toHaveBeenCalledExactlyOnceWith(
    appendComposerText("Existing draft", formatCodeCommentForComposer({ ...pending, path: "C:/shared/src/a.ts" })),
  )
  expect(store.comments).toHaveLength(0)
})
