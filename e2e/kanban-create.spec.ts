import { expect, test } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h, ref } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import KanbanBoard from '/src/components/kanban/KanbanBoard.vue'
import zhCN from '/src/i18n/locales/zh-CN'
import '/src/style.css'
const busy = ref(false), error = ref(''), saved = ref(null)
createApp({render: () => h('div', {style:'height:700px'}, [h(KanbanBoard, {
  cards:[], projects:[{value:'/project', label:'Project'}], selectedProject:'/project',
  busy:busy.value, error:error.value,
  onCreate: async payload => {
    busy.value = true; error.value = ''
    await new Promise(resolve => setTimeout(resolve, 30))
    if (window.failSave) error.value = '保存失败'
    else saved.value = payload
    busy.value = false
  },
}), h('pre', {id:'saved'}, JSON.stringify(saved.value))])})
  .use(createPinia()).use(createI18n({legacy:false,locale:'zh-CN',messages:{'zh-CN':zhCN}})).mount('#app')
</script></body></html>`

let harness: VueHarness
test.beforeAll(async () => {
  harness = await startVueHarness({ name: "kanban-create", port: 1542, html })
})
test.afterAll(async () => harness?.close())
test.beforeEach(async ({ page }) => {
  await page.route("**/api/invoke", async route => {
    const { command } = route.request().postDataJSON()
    const data =
      command === "models_config_get"
        ? {
            providers: {
              test: {
                models: [
                  { id: "reasoner", name: "Reasoner", reasoning: true },
                  { id: "other", name: "Other", reasoning: true },
                ],
              },
            },
          }
        : command === "pi_settings_get"
          ? { defaultProvider: "test", defaultModel: "reasoner", defaultThinkingLevel: "medium" }
          : command === "workspace_git_info"
            ? { branch: "main", branches: ["main"], unborn_branch: false, worktree: false, worktrees: [] }
            : {}
    await route.fulfill({ json: { data } })
  })
  await page.goto(harness.url)
  await page.getByRole("button", { name: "新建待办", exact: true }).click()
})

const image = {
  name: "photo.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZfoAAAAASUVORK5CYII=",
    "base64",
  ),
}

test("the shared composer saves the selected model, thinking level, text and image", async ({ page }) => {
  const dialog = page.getByRole("dialog", { name: "新建待办" })
  await dialog.getByRole("textbox").fill("实现登录页")
  await dialog.locator('input[type="file"]').setInputFiles(image)
  await expect(dialog.locator("img")).toBeVisible()
  await dialog.getByRole("button", { name: /Reasoner/ }).click()
  await page.getByRole("menuitem", { name: /Reasoner/ }).hover()
  await page.getByRole("menuitemradio", { name: "Other", exact: true }).click()
  const slider = page.getByRole("slider")
  await slider.focus()
  await slider.press("End")
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
  await dialog.getByRole("button", { name: "保存待办", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const saved = JSON.parse((await page.locator("#saved").textContent())!)
  expect(saved).toMatchObject({
    project: "/project",
    message: "实现登录页",
    modelKey: "test/other",
    thinkingLevel: "high",
  })
  expect(saved.attachments[0]).toMatchObject({ filename: "photo.png", mediaType: "image/png" })
  expect(saved.attachments[0].url).toMatch(/^data:image\/png;base64,/)
})

test("an image-only todo survives a failed save and can be retried", async ({ page }) => {
  const dialog = page.getByRole("dialog", { name: "新建待办" })
  await dialog.locator('input[type="file"]').setInputFiles(image)
  await page.evaluate(() => Reflect.set(window, "failSave", true))
  await dialog.getByRole("button", { name: "保存待办", exact: true }).click()
  await expect(dialog.getByRole("alert")).toContainText("保存失败")
  await expect(dialog.locator("img")).toBeVisible()
  await page.evaluate(() => Reflect.set(window, "failSave", false))
  await dialog.getByRole("button", { name: "保存待办", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(JSON.parse((await page.locator("#saved").textContent())!).attachments).toHaveLength(1)
})
