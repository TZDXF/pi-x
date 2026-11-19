import { test, expect } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h, ref, reactive } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import messages from '/src/i18n/locales/en.ts'
import ChatUserPrompt from '/src/components/chat/ChatUserPrompt.vue'
import CodeCommentPreview from '/src/components/chat/CodeCommentPreview.vue'
import { serializeComposerPromptContexts } from '/src/lib/promptContexts.ts'
import { useCodeCommentsStore } from '/src/stores/codeComments.ts'
import { useCodeCommentInsertion } from '/src/composables/useCodeCommentInsertion.ts'
import '/src/style.css'
const comments = [
  { path: 'src/main.ts', startLine: 80, endLine: 82, selectedText: 'const value = 80', comment: 'Check this range' },
  { path: 'docs/readme.md', startLine: 70, endLine: 70, selectedText: '# Heading', comment: 'Check this line' },
  { path: 'missing.ts', startLine: 3, endLine: 4, selectedText: 'removed', comment: 'Deleted file' },
  { path: 'C:/other/src/file.ts', startLine: 5, endLine: 5, selectedText: 'code', comment: 'Other folder' },
]
const prompt = serializeComposerPromptContexts('Please review', { comments, selections: [] })
const history = location.search.includes('history')
const isolated = location.search.includes('isolated')
const entry = history ? { kind: 'user', id: 1, text: prompt } : { kind: 'user', id: 1, text: 'Please review', contextText: prompt }
const edit = reactive({ editedPrompt: null, editedText: '', editBusy: false, editBlocked: false, lastUserPromptId: null })
createApp({ setup() {
  const selected = ref(null)
  const composer = ref({ textInput: 'Existing draft', setTextInput(text) { composer.value.textInput = text } })
  const { insertCodeComment } = useCodeCommentInsertion(composer)
  const codeComments = useCodeCommentsStore()
  codeComments.add('C:/demo', { path: 'src/main.ts', startLine: 80, endLine: 82, selectedText: 'const value = 80', comment: 'Pending comment' })
  codeComments.add('C:/demo', { path: 'src/file.ts', root: 'C:/other', startLine: 5, endLine: 5, selectedText: 'code', comment: 'Cross-root comment' })
  return () => h('main', { style: 'padding:24px;max-width:800px' }, [
    h(ChatUserPrompt, { entry, edit, onOpenCodeComment: c => selected.value = c }),
    h(CodeCommentPreview, {
      comment: selected.value,
      roots: ['C:/demo', 'C:/other'],
      commentProject: isolated ? undefined : 'C:/demo',
      onClose: () => selected.value = null,
      onInsertCodeComment: insertCodeComment,
    }),
    h('output', { 'data-inserted-composer': '' }, composer.value.textInput),
  ])
}}).use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } })).use(createPinia()).mount('#app')
</script></body></html>`

let harness: VueHarness
test.beforeAll(async () => {
  harness = await startVueHarness({ name: "code-comment-navigation", port: 1489, html })
})
test.afterAll(async () => {
  await harness.close()
})
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.set(window, "isTauri", true)
    Reflect.set(window, "__fileReads", [])
    Reflect.set(window, "__TAURI_INTERNALS__", {
      invoke: async (command: string, args: { project: string; path: string }) => {
        if (command !== "read_file_preview") throw Error("Unexpected command: " + command)
        ;(Reflect.get(window, "__fileReads") as unknown[]).push(args)
        if (args.path === "missing.ts") throw 'PIXERR:{"code":"previewPathInvalid","fallback":"invalid path"}'
        return {
          kind: "text",
          text: Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\n"),
          truncated: false,
        }
      },
    })
  })
})

for (const history of [false, true]) {
  test(`${history ? "history" : "live"} messages show clickable annotations and locate source ranges`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await page.goto(harness.url + (history ? "?history" : ""))
    const tags = page.locator("[data-code-comment-tag]")
    await expect(tags).toHaveCount(4)
    await expect(page.getByText("Please review", { exact: true })).toBeVisible()
    await expect(page.getByText("# Code comments:", { exact: false })).toHaveCount(0)
    await tags.first().click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByRole("heading", { level: 2 })).toHaveText("src/main.ts:80-82")
    const target = dialog.locator('[data-line="80"]')
    await expect(target).toBeInViewport()
    for (const line of [80, 81, 82])
      await expect(dialog.locator(`[data-line="${line}"]`)).toHaveClass(/bg-amber-500\/15/)
    if (!history) await page.screenshot({ path: "temp/code-comment-range.png" })
    await page.keyboard.press("Escape")
    await tags.nth(1).focus()
    await page.keyboard.press("Enter")
    await expect(dialog.locator('[data-line="70"]')).toBeInViewport()
    await expect(dialog.getByRole("button", { name: "Rendered view" })).toBeVisible()
    await page.keyboard.press("Escape")
    await tags.nth(3).click()
    await expect(dialog.locator('[data-line="5"]')).toBeVisible()
    expect(await page.evaluate(() => Reflect.get(window, "__fileReads").at(-1))).toMatchObject({
      project: "C:/other",
      path: "src/file.ts",
    })
    await page.keyboard.press("Escape")
    await tags.nth(2).click()
    await expect(dialog.getByRole("alert")).toContainText("File does not exist or is unavailable")
    if (history) await page.screenshot({ path: "temp/code-comment-missing.png" })
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).toHaveCount(0)
    expect(errors).toEqual([])
  })
}

test("history preview inserts a pending annotation into the existing composer draft", async ({ page }) => {
  await page.goto(harness.url + "?history")
  await page.locator("[data-code-comment-tag]").first().click()
  const dialog = page.getByRole("dialog")
  await dialog.getByRole("button", { name: "Insert into composer", exact: true }).click()
  const inserted = page.locator("[data-inserted-composer]")
  await expect(inserted).toContainText("Existing draft")
  await expect(inserted).toContainText("## Comment 1")
  await expect(inserted).toContainText("Pending comment")
  await expect(inserted).not.toContainText("# Code comments:")
  await expect(dialog.locator("[data-code-comment-id]")).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: "Insert into composer", exact: true })).toHaveCount(0)

  await page.keyboard.press("Escape")
  await page.locator("[data-code-comment-tag]").nth(3).click()
  await dialog.getByRole("button", { name: "Insert into composer", exact: true }).click()
  await expect(inserted).toContainText("File: C:/other/src/file.ts")
  await expect(inserted).toContainText("Cross-root comment")
  await expect(dialog.locator("[data-code-comment-id]")).toHaveCount(0)
})

test("history preview without a session receiver hides pending chips and insertion", async ({ page }) => {
  await page.goto(harness.url + "?history&isolated")
  await page.locator("[data-code-comment-tag]").first().click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.locator('[data-line="80"]')).toBeVisible()
  await expect(dialog.locator("[data-code-comment-id]")).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: "Insert into composer", exact: true })).toHaveCount(0)
})
