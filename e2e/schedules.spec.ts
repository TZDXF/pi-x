import { test, expect } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

interface ScheduledTaskInput {
  id?: string
  expression: string
  provider: string
  model: string
  enabled: boolean
}

interface ScheduledTask extends ScheduledTaskInput {
  id: string
  nextRun: number
  lastRun: string | null
  status: string
  error: string | null
  sessionFile: string | null
}

interface OpenedSession {
  file: string
  project: string
}

interface ModelInfo {
  id: string
  name: string
  reasoning: boolean
}

interface TauriInvokeArgs {
  input?: ScheduledTaskInput
}

declare global {
  interface Window {
    isTauri: boolean
    calls: Array<{ command: string; args: TauriInvokeArgs }>
    tasks: ScheduledTask[]
    openedSession?: OpenedSession
    __TAURI_INTERNALS__: {
      invoke: (command: string, args: TauriInvokeArgs) => Promise<unknown>
    }
  }
}

const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import messages from '/src/i18n/locales/zh-CN.ts'
import WorkspaceSidebar from '/src/components/WorkspaceSidebar.vue'
import ScheduledTasksPage from '/src/components/ScheduledTasksPage.vue'
import { useRoute, navigate } from '/src/lib/router.ts'
import { useWorkspaceStore } from '/src/stores/workspace.ts'
import '/src/style.css'
const app = createApp({setup() { const route = useRoute(); return () => h('div', { class: 'flex h-screen' }, [
  h(WorkspaceSidebar, { project: 'C:/demo', ready: true, busy: false, onSchedules: () => navigate('/schedules') }),
  route.value.name === 'schedules' ? h('main', { class: 'flex flex-1 min-h-0' }, [h(ScheduledTasksPage, { project: 'C:/demo', onResumeSession: (file, project) => { window.openedSession = { file, project } } })]) : h('main', 'Workspace'),
]) }})
app.use(createPinia()).use(createI18n({legacy:false,locale:'zh-CN',messages:{'zh-CN':messages}}))
useWorkspaceStore().projects = ['C:/demo']
app.mount('#app')
</script></body></html>`

let harness: VueHarness | null = null

test.beforeAll(async () => {
  harness = await startVueHarness({
    name: "schedules",
    port: 1457,
    html,
  })
})

test.afterAll(async () => {
  if (!harness) throw new Error("Vue harness was not started")
  await harness.close()
})

test("schedules page regression", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))

  await page.addInitScript(() => {
    window.isTauri = true
    window.calls = []
    window.tasks = []
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        window.calls.push({ command, args })
        if (command === "schedule_list") return structuredClone(window.tasks)
        if (command === "schedule_save") {
          const input = args.input as ScheduledTaskInput
          const saved: ScheduledTask = {
            ...input,
            id: input.id || "test-task",
            nextRun: Date.now() + 60000,
            lastRun: null,
            status: "idle",
            error: null,
            sessionFile: null,
          }
          window.tasks = [saved]
          return saved
        }
        if (command === "schedule_run") {
          Object.assign(window.tasks[0], { status: "running", sessionFile: "scheduled.jsonl" })
          return
        }
        if (command === "schedule_delete") {
          window.tasks = []
          return
        }
        if (command === "models_config_get") {
          const models: ModelInfo[] = [{ id: "test-model", name: "Test model", reasoning: true }]
          return { providers: { test: { models } } }
        }
        if (command === "pi_settings_get") return { defaultProvider: "test", defaultModel: "test-model", skills: [] }
        if (command === "session_list") return []
        return {}
      },
    }
  })

  await page.goto(harness!.url)
  const entry = page.getByRole("button", { name: "定时任务", exact: true })
  await expect(entry).toBeVisible()
  await expect(entry.locator("xpath=preceding-sibling::*[1]")).toContainText("新会话")
  await entry.click()

  await expect(page.getByRole("heading", { name: "定时任务" })).toBeVisible()
  expect(new URL(page.url()).hash).toBe("#/schedules")
  await expect(page.getByRole("dialog")).toHaveCount(0)

  await page.getByRole("button", { name: "新建定时任务", exact: true }).click()
  await page.getByLabel("标题", { exact: true }).fill("每周项目巡检")
  await page.getByRole("combobox", { name: "重复频率" }).click()
  for (const name of ["每小时", "每天", "工作日（周一至周五）", "每周", "每月", "自定义"]) {
    await expect(page.getByRole("option", { name, exact: true })).toHaveCount(1)
  }
  await page.getByRole("option", { name: "每周", exact: true }).click()
  await page.getByRole("combobox", { name: "星期", exact: true }).click()
  await page.getByRole("option", { name: "周五", exact: true }).click()
  await page.getByRole("combobox", { name: "项目", exact: true }).click()
  await expect(page.getByRole("option", { name: "demo", exact: true })).toHaveCount(1)
  await expect(page.getByRole("option", { name: /C:\/demo/ })).toHaveCount(0)
  await page.keyboard.press("Escape")

  const hour = page.getByRole("spinbutton").first()
  const minute = page.getByRole("spinbutton").last()
  await hour.focus()
  await hour.press("1")
  await hour.press("0")
  await minute.focus()
  await minute.press("3")
  await minute.press("0")
  await expect(hour).toHaveText("10")
  await expect(minute).toHaveText("30")

  await page.getByLabel("任务指令", { exact: true }).fill("检查项目测试与待办事项，汇总结果，不修改文件。")
  if (process.env.PI_SCHEDULE_SCREENSHOT) {
    await page.screenshot({ path: process.env.PI_SCHEDULE_SCREENSHOT })
  }
  await page.getByRole("button", { name: "保存", exact: true }).click()
  await expect(page.getByRole("heading", { name: "每周项目巡检" })).toBeVisible()

  let saved = await page.evaluate<ScheduledTask | undefined>(() => window.tasks[0])
  expect(saved?.expression).toBe("30 10 * * FRI")
  expect(saved?.provider).toBe("test")
  expect(saved?.model).toBe("test-model")

  await page.getByRole("button", { name: "编辑", exact: true }).click()
  await expect(page.getByRole("spinbutton").first()).toHaveAttribute("aria-valuenow", "10")
  await expect(page.getByRole("spinbutton").last()).toHaveAttribute("aria-valuenow", "30")
  await page.getByRole("combobox", { name: "重复频率" }).click()
  await page.getByRole("option", { name: "自定义", exact: true }).click()
  await page.getByLabel("Cron 表达式").fill("*/15 9-17 * * MON-FRI")
  await page.getByRole("button", { name: "保存", exact: true }).click()

  await page.getByRole("button", { name: "暂停", exact: true }).click()
  await expect(page.locator("main").getByText("已暂停")).toBeVisible()
  saved = await page.evaluate<ScheduledTask | undefined>(() => window.tasks[0])
  expect(saved?.enabled).toBe(false)
  expect(saved?.expression).toBe("*/15 9-17 * * MON-FRI")
  await page.getByRole("button", { name: "恢复", exact: true }).click()
  await expect(page.getByRole("button", { name: "暂停", exact: true })).toBeVisible()

  await page.getByRole("button", { name: "立即执行", exact: true }).click()
  await page.getByRole("button", { name: "查看执行过程", exact: true }).click()
  const openedSession = await page.evaluate<OpenedSession | undefined>(() => window.openedSession)
  expect(openedSession).toEqual({ file: "scheduled.jsonl", project: "C:/demo" })
  await expect(page.getByRole("button", { name: "立即执行", exact: true })).toBeDisabled()

  await page.evaluate(() => {
    window.tasks[0].status = "success"
  })
  await expect(page.getByRole("button", { name: "查看最近结果", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "删除", exact: true }).click()
  await expect(page.getByText("确定删除此定时任务？")).toBeVisible()
  await page.getByRole("button", { name: "删除", exact: true }).last().click()
  await expect(page.getByText("暂无定时任务，创建一个自动执行重复工作。")).toBeVisible()

  expect(errors).toEqual([])
})
