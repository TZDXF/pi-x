import { expect, test } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h, ref } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import KanbanBoard from '/src/components/kanban/KanbanBoard.vue'
import CreateProjectDialog from '/src/components/CreateProjectDialog.vue'
import { useWorkspaceStore } from '/src/stores/workspace'
import zhCN from '/src/i18n/locales/zh-CN'
import '/src/style.css'
const busy = ref(false), error = ref(''), saved = ref(null), projectOpen = ref(false)
const pinia = createPinia()
useWorkspaceStore(pinia).projects = ['/project']
createApp({render: () => h('div', {style:'height:700px'}, [
h(CreateProjectDialog, {open:projectOpen.value, onClose: () => { projectOpen.value = false }}),
h(KanbanBoard, {
  cards:[], projects:[{value:'/project', label:'Project'}], selectedProject:'/project',
  busy:busy.value, error:error.value,
  onOpenProject: () => { projectOpen.value = true },
  onCreate: async payload => {
    busy.value = true; error.value = ''
    await new Promise(resolve => setTimeout(resolve, 30))
    if (window.failSave) error.value = '保存失败'
    else saved.value = payload
    busy.value = false
  },
}), h('pre', {id:'saved'}, JSON.stringify(saved.value))])})
  .use(pinia).use(createI18n({legacy:false,locale:'zh-CN',messages:{'zh-CN':zhCN}})).mount('#app')
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

test("the project picker opens inside the creation dialog", async ({ page }) => {
  const dialog = page.getByRole("dialog", { name: "新建待办" })
  await expect(dialog.getByText("项目", { exact: true })).toHaveCount(0)
  await expect(dialog.getByText("任务消息", { exact: true })).toHaveCount(0)
  await dialog.getByRole("button", { name: /project/i }).click()
  const content = page.locator('[data-slot="popover-content"]')
  await expect(content).toBeVisible()
  await expect(content.getByRole("textbox")).toBeVisible()
  await content.getByRole("button", { name: /project/i }).click()
  await expect(content).toHaveCount(0)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("button", { name: "main", exact: true })).toBeVisible()
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
})

test("creating a project from a todo keeps the latest dialog interactive", async ({ page }) => {
  const todo = page.getByRole("dialog", { name: "新建待办" })
  await todo.getByRole("textbox").fill("保留待办内容")
  for (let attempt = 0; attempt < 2; attempt++) {
    await todo.getByRole("button", { name: /project/i }).click()
    await page.getByRole("button", { name: "添加项目", exact: true }).click()
    const project = page.getByRole("dialog", { name: "添加项目", exact: true })
    await expect(project).toBeVisible()
    await project.getByRole("textbox").click({ timeout: 5000 })
    await project.getByRole("textbox").fill("新项目")
    await expect(project.getByRole("textbox")).toBeFocused()
    if (attempt === 0) await page.screenshot({ path: "temp/kanban-create-project-dialog.png" })
    await page.keyboard.press("Escape")
    await expect(project).toHaveCount(0)
    await expect(todo).toBeVisible()
    await expect(todo.getByRole("textbox")).toHaveText("保留待办内容")
  }
  await todo.getByRole("textbox").fill("继续编辑待办")
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
