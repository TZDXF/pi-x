import { test, expect, type Page } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

// 回归（TZD-132 P2）：代码批注弹窗切到 Rendered view 时，Markdown 里的相对图片
// 必须按批注目标文件的目录解析并真实读出；此前读取回调忽略传入路径，永远重读
// Markdown 本体，图片只剩 alt 占位。
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
const markdown = "# Guide\n\n![角色协作](assets/spec/02/02-01-角色协作.png)\n\nAfter the image"
const image = "docs/assets/spec/02/02-01-角色协作.png"

const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h, ref, reactive } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import messages from '/src/i18n/locales/en.ts'
import ChatUserPrompt from '/src/components/chat/ChatUserPrompt.vue'
import CodeCommentPreview from '/src/components/chat/CodeCommentPreview.vue'
import { serializeComposerPromptContexts } from '/src/lib/promptContexts.ts'
import '/src/style.css'
const comments = [{ id: 'tag-1', path: 'C:/demo/docs/guide.md', startLine: 3, endLine: 3, selectedText: 'image target', comment: 'See diagram' }]
const contextText = serializeComposerPromptContexts('Please review', { comments, selections: [] })
const entry = { kind: 'user', id: 1, text: 'Please review', contextText }
const edit = reactive({ editedPrompt: null, editedText: '', editBusy: false, editBlocked: false, lastUserPromptId: null })
createApp({ setup() {
  const selected = ref(null)
  return () => h('main', [
    h(ChatUserPrompt, { entry, edit, onOpenCodeComment: c => selected.value = c }),
    h(CodeCommentPreview, { comment: selected.value, roots: ['C:/demo'], onClose: () => selected.value = null }),
  ])
}}).use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } })).use(createPinia()).mount('#app')
</script></body></html>`

let harness: VueHarness
test.beforeAll(async () => {
  harness = await startVueHarness({ name: "markdown-image-comment", port: 1451, html })
})
test.afterAll(async () => {
  await harness.close()
})

test("the annotation dialog renders relative Markdown images instead of alt placeholders", async ({
  page,
}: {
  page: Page
}) => {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.addInitScript(
    (fixture: { markdown: string; png: string; image: string }) => {
      Reflect.set(window, "isTauri", true)
      const reads: string[] = []
      Reflect.set(window, "__previewReads", reads)
      Reflect.set(window, "__TAURI_INTERNALS__", {
        invoke: async (command: string, args: { path: string }) => {
          if (command !== "read_file_preview") throw Error("Unexpected command: " + command)
          reads.push(args.path)
          if (args.path === "docs/guide.md")
            return { kind: "text", text: fixture.markdown, truncated: false, mime: null, data: null }
          if (args.path === fixture.image)
            return { kind: "image", text: null, truncated: false, mime: "image/png", data: fixture.png }
          throw 'PIXERR:{"code":"previewPathInvalid","fallback":"invalid path"}'
        },
      })
    },
    { markdown, png, image },
  )

  await page.goto(harness.url)
  await page.locator("[data-code-comment-tag]").click()
  const dialog = page.getByRole("dialog")
  await expect(dialog.locator('[data-line="3"]')).toBeVisible()
  await dialog.getByRole("button", { name: "Rendered view" }).click()
  const rendered = dialog.locator("[data-markdown-image]")
  await expect(rendered).toHaveCount(1)
  await expect.poll(() => rendered.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
  await expect(dialog.locator("[data-markdown-image-missing]")).toHaveCount(0)
  // 回归：图片路径必须真的被请求，且项目根来自批注目标文件。
  expect(await page.evaluate(() => Reflect.get(window, "__previewReads"))).toEqual(["docs/guide.md", image])
  expect(errors).toEqual([])
})
