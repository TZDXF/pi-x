import { test, expect, type Page } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

interface ProjectlessConfig {
  projectlessDir?: string
}

interface ProjectlessCallArguments {
  config?: ProjectlessConfig
}

interface ProjectlessCall {
  command: string
  args: ProjectlessCallArguments
}

interface ProjectlessMessages {
  name: string
  settingsLabel: string
  reset: string
  invalidPath: string
}

interface WelcomeMessages {
  openFolder: string
}

interface LocaleMessages {
  projectless: ProjectlessMessages
  welcome: WelcomeMessages
}

interface ProjectlessWindow {
  isTauri: boolean
  defaultProjectlessDir: string
  projectlessDir: string
  config: ProjectlessConfig
  calls: ProjectlessCall[]
  projectlessOpened?: boolean
  __messages?: LocaleMessages
  __TAURI_INTERNALS__?: {
    invoke: (command: string, args: ProjectlessCallArguments) => Promise<unknown>
  }
}

const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import messages from '/src/i18n/locales/zh-CN.ts'
import WelcomeView from '/src/components/WelcomeView.vue'
import SettingsPage from '/src/components/SettingsPage.vue'
import WorkspaceSidebar from '/src/components/WorkspaceSidebar.vue'
import { useWorkspaceStore } from '/src/stores/workspace.ts'
import '/src/style.css'
const view = new URLSearchParams(location.search).get('view')
const pinia = createPinia()
// 断言对照现用文案，避免测试写死具体措辞。
window.__messages = messages
const projectless = () => { window.projectlessOpened = true }
const app = createApp({ setup() {
  if (view === 'sidebar') return () => h('div', { class: 'flex h-screen' }, [
    h(WorkspaceSidebar, { project: window.projectlessDir, ready: true, busy: false, onProjectless: projectless })])
  if (view === 'settings') return () => h(SettingsPage, { project: 'C:/demo' })
  return () => h('div', { class: 'flex h-screen' }, [h(WelcomeView, { phase: 'pick', config: {}, onOpenProjectless: projectless })])
} })
app.use(pinia).use(createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': messages } }))
setActivePinia(pinia)
if (view === 'sidebar') {
  // 侧栏按解析结果命名项目；未解析时应退回目录名。
  useWorkspaceStore().projects = [window.projectlessDir, 'C:/demo']
  await useWorkspaceStore().ensureProjectless()
}
app.mount('#app')
</script></body></html>`

test.use({ viewport: { width: 1280, height: 1050 } })

test.describe("projectless", () => {
  let harness!: VueHarness

  test.beforeAll(async () => {
    harness = await startVueHarness({ name: "projectless", port: 1454, html })
  })

  test.afterAll(async () => {
    await harness.close()
  })

  test("exposes, names, and persists projectless sessions", async ({ page }: { page: Page }) => {
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    const DEFAULT_DIR = "C:/Users/you/.pix/workspace"

    // 后端命令桩：目录由 projectless_dir_resolve 解析，配置写入记录在 window.config。
    await page.addInitScript((defaultDir: string) => {
      const projectWindow = window as Window & typeof globalThis & ProjectlessWindow
      projectWindow.isTauri = true
      projectWindow.defaultProjectlessDir = defaultDir
      projectWindow.projectlessDir = defaultDir
      projectWindow.config = {}
      projectWindow.calls = []
      const internals = {
        invoke: async (command: string, args: ProjectlessCallArguments): Promise<unknown> => {
          projectWindow.calls.push({ command, args })
          if (command === "app_config_get") return structuredClone(projectWindow.config)
          if (command === "app_config_save") {
            if (!args.config) throw new Error("app_config_save requires config")
            projectWindow.config = structuredClone(args.config)
            return
          }
          if (command === "projectless_dir_resolve") {
            return {
              dir: projectWindow.projectlessDir,
              defaultDir: projectWindow.defaultProjectlessDir,
              isDefault: projectWindow.projectlessDir === projectWindow.defaultProjectlessDir,
            }
          }
          if (command === "session_list") return []
          return {}
        },
      }
      Reflect.set(projectWindow, "__TAURI_INTERNALS__", internals)
    }, DEFAULT_DIR)

    await openView(page, `${harness.url}?view=welcome`)
    // 文案取自当前语言包，避免测试写死具体措辞。
    const text = await page.evaluate(() => {
      const messages = (window as Window & typeof globalThis & ProjectlessWindow).__messages
      if (!messages) throw new Error("locale messages are unavailable")
      return {
        name: messages.projectless.name,
        label: messages.projectless.settingsLabel,
        reset: messages.projectless.reset,
        invalidPath: messages.projectless.invalidPath,
        openFolder: messages.welcome.openFolder,
      }
    })

    // 欢迎页：无项目会话入口可点击，且不触发目录选择器。
    const entry = page.getByRole("button", { name: text.name, exact: true })
    await expect(entry).toBeVisible()
    await expect(page.getByRole("button", { name: text.openFolder, exact: true })).toHaveCount(1)
    await entry.click()
    expect(
      await page.evaluate(() => (window as Window & typeof globalThis & ProjectlessWindow).projectlessOpened),
    ).toBe(true)
    expect(
      await page.evaluate(() =>
        (window as Window & typeof globalThis & ProjectlessWindow).calls.some(call =>
          call.command.startsWith("plugin:dialog"),
        ),
      ),
    ).toBe(false)

    // 侧栏：无项目会话显示专用名称，普通项目仍显示目录名。
    await openView(page, `${harness.url}?view=sidebar`)
    const projectlessButton = page.locator(`button[aria-label="${text.name}"]`)
    await expect(projectlessButton).toBeVisible()
    await expect(page.getByText("workspace", { exact: true })).toHaveCount(0)
    await expect(page.getByText("demo", { exact: true })).toHaveCount(1)
    // The sidebar exposes this action for hover/touch only, so trigger its click handler directly.
    await projectlessButton.dispatchEvent("click")
    expect(
      await page.evaluate(() => (window as Window & typeof globalThis & ProjectlessWindow).projectlessOpened),
    ).toBe(true)

    // 设置项：展示默认目录、拒绝非法路径、保存绝对路径、与默认值一致时不写入配置。
    await openView(page, `${harness.url}?view=settings#/settings/general`)
    const input = page.getByLabel(text.label)
    await expect(input).toBeVisible()
    expect(await input.getAttribute("placeholder")).toBe(DEFAULT_DIR)
    await input.fill("work")
    await input.press("Enter")
    await expect(page.getByRole("alert")).toHaveText(text.invalidPath)
    expect(
      await page.evaluate(() =>
        (window as Window & typeof globalThis & ProjectlessWindow).calls.some(
          call => call.command === "app_config_save",
        ),
      ),
    ).toBe(false)
    await input.fill("D:/pix/scratch")
    await input.press("Enter")
    await page.waitForFunction(
      () => (window as Window & typeof globalThis & ProjectlessWindow).config.projectlessDir === "D:/pix/scratch",
    )
    await input.fill(DEFAULT_DIR)
    await input.press("Enter")
    await page.waitForFunction(
      () => (window as Window & typeof globalThis & ProjectlessWindow).config.projectlessDir === undefined,
    )
    await expect(page.getByRole("button", { name: text.reset })).toBeDisabled()

    expect(errors).toEqual([])
  })
})

/** 打开一个视图并等应用渲染完成；开发服务器可能因源文件改动刷新页面，重试即可。 */
async function openView(page: Page, url: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.goto(url)
    try {
      await page.waitForFunction(() => (document.querySelector("#app")?.childElementCount ?? 0) > 0, undefined, {
        timeout: 15000,
      })
      return
    } catch (error) {
      lastError = error
    }
  }
  if (lastError instanceof Error) throw lastError
  throw new Error(`unable to open projectless view: ${url}`)
}
