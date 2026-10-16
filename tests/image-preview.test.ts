import { expect, test } from "vitest"
import { chatSource } from "./fixtures/chatSources"

test("image previews fill the area below the title bar without a modal overlay", () => {
  for (const file of ["ChatDialogs.vue", "ToolImageGallery.vue"]) {
    const source = chatSource(`components/chat/${file}`)
    expect(source).toContain(':modal="false"')
    expect(source).toContain("<ImagePreviewContent")
  }
  const preview = chatSource("components/chat/ImagePreviewContent.vue")
  expect(preview).toContain("inset-x-0 bottom-0 top-9")
  expect(preview).toContain("bg-transparent")
  expect(preview).not.toMatch(/max-w-|DialogOverlay/)
  expect(preview).toContain("@interact-outside.prevent")
  expect(preview).toContain("<DialogClose as-child>")
  expect(chatSource("components/WindowTitleBar.vue")).toContain("h-9")
})
