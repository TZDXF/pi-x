import { test, expect, type Page } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

interface DirectoryEntry {
  name: string
  path: string
  is_dir: boolean
}

type DirectoryMap = Record<string, DirectoryEntry[]>

interface HarnessWindow {
  isTauri: boolean
  __TAURI_INTERNALS__?: {
    invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>
    transformCallback: (callback: (payload: unknown) => void, once?: boolean) => number
  }
  __TAURI_EVENT_PLUGIN_INTERNALS__?: { unregisterListener: (event: string, id: number) => void }
  __unmountHarness?: () => void
  __harness?: {
    emit: (event: string, payload: unknown) => void
    calls: { command: string; args: Record<string, unknown> }[]
    interestHistory: string[][]
    setFileText: (text: string) => void
    setDirs: (dirs: DirectoryMap) => void
  }
}

const initialDirs: DirectoryMap = {
  "": [
    { name: "dist", path: "dist", is_dir: true },
    { name: "src", path: "src", is_dir: true },
    { name: "main.rs", path: "main.rs", is_dir: false },
  ],
  src: [{ name: "lib.ts", path: "src/lib.ts", is_dir: false }],
  dist: [{ name: "bundle.js", path: "dist/bundle.js", is_dir: false }],
}

const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import messages from '/src/i18n/locales/en.ts'
import ProjectFiles from '/src/components/ProjectFiles.vue'
import '/src/style.css'
const app = createApp({ render: () => h('div', { style: 'display:flex;height:650px;width:1100px' }, [h(ProjectFiles, { project: 'C:/demo' })]) })
app.use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } })).use(createPinia()).mount('#app')
// 暴露卸载入口，模拟关闭文件 tab 时组件销毁。
window.__unmountHarness = () => app.unmount()
</script></body></html>`

test.use({ viewport: { width: 1280, height: 1000 } })

test.describe("project file sync", () => {
  let harness!: VueHarness

  test.beforeAll(async () => {
    harness = await startVueHarness({ name: "project-file-sync", port: 1454, html })
  })

  test.afterAll(async () => {
    await harness.close()
  })

  /**
   * Fake the Tauri IPC surface with an in-memory project. `emit` delivers
   * `pi://project-files-changed` batches exactly like the Rust watcher would,
   * so these tests cover the front-end half of the contract (the Rust half has
   * its own unit tests against real notify events).
   */
  async function open(page: Page) {
    await page.addInitScript((fixture: DirectoryMap) => {
      const harnessWindow = window as unknown as HarnessWindow
      harnessWindow.isTauri = true
      const state = {
        dirs: fixture,
        fileText: "line 1\nline 2\nline 3\n",
        callbacks: new Map<number, (payload: unknown) => void>(),
        nextId: 1,
        calls: [] as { command: string; args: Record<string, unknown> }[],
      }
      harnessWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined }
      const api = {
        emit: (event: string, payload: unknown) => {
          for (const callback of state.callbacks.values()) callback({ event, id: state.nextId, payload })
        },
        calls: state.calls,
        interestHistory: [] as string[][],
        setFileText: (text: string) => {
          state.fileText = text
        },
        setDirs: (dirs: DirectoryMap) => {
          state.dirs = dirs
        },
      }
      harnessWindow.__harness = api
      Reflect.set(harnessWindow, "__TAURI_INTERNALS__", {
        transformCallback: (callback: (payload: unknown) => void) => {
          const id = state.nextId++
          state.callbacks.set(id, callback)
          return id
        },
        invoke: async (command: string, args: Record<string, unknown>) => {
          state.calls.push({ command, args })
          if (command === "list_project_directory") return state.dirs[(args.path as string) ?? ""] ?? []
          if (command === "read_file_preview") {
            return { kind: "text", text: state.fileText, truncated: false, mime: null, data: null }
          }
          if (command === "set_project_files_interest") {
            api.interestHistory.push(args.paths as string[])
            return null
          }
          if (
            command === "watch_project_files" ||
            command === "unwatch_project_files" ||
            command === "plugin:event|unlisten"
          ) {
            return null
          }
          if (command === "plugin:event|listen") return 1
          throw Error("unexpected command " + command)
        },
      })
    }, initialDirs)
    await page.goto(harness.url)
    await expect(page.getByRole("button", { name: "main.rs" })).toBeVisible()
  }

  test("M2: a visible directory outside the initial scope starts syncing once loaded", async ({ page }) => {
    await open(page)
    const preview = page.locator('section[aria-label="File preview"]')

    // 用户展开 dist 并打开其中文件：关注范围随之扩大。
    await page.getByRole("button", { name: "dist" }).click()
    await page.getByRole("button", { name: "bundle.js" }).click()
    await expect(preview).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => (window as unknown as HarnessWindow).__harness!.interestHistory.slice(-1)[0]))
      .toEqual(["", "dist", "dist/bundle.js"])

    // 后端按新的关注范围上报该目录内的变更：预览应自动重新读取。
    await page.evaluate(() => {
      const harness = (window as unknown as HarnessWindow).__harness!
      harness.setFileText("line 1\nline 2 changed\nline 3\n")
      harness.emit("pi://project-files-changed", {
        project: "C:/demo",
        paths: ["dist/bundle.js", "dist"],
        reset: false,
      })
    })
    await expect(preview).toContainText("line 2 changed")

    // 同一目录新增文件也应出现在列表里（列表同步，不只是预览）。
    await page.evaluate(() => {
      const harness = (window as unknown as HarnessWindow).__harness!
      harness.setDirs({
        "": [
          { name: "dist", path: "dist", is_dir: true },
          { name: "src", path: "src", is_dir: true },
          { name: "main.rs", path: "main.rs", is_dir: false },
        ],
        src: [{ name: "lib.ts", path: "src/lib.ts", is_dir: false }],
        dist: [
          { name: "bundle.js", path: "dist/bundle.js", is_dir: false },
          { name: "report.txt", path: "dist/report.txt", is_dir: false },
        ],
      })
      harness.emit("pi://project-files-changed", {
        project: "C:/demo",
        paths: ["dist/report.txt", "dist"],
        reset: false,
      })
    })
    await expect(page.getByRole("button", { name: "report.txt" })).toBeVisible()
    // 关注范围只包含已加载目录与打开的文件，未加载子树不产生事件开销。
    const interest = await page.evaluate(
      () => (window as unknown as HarnessWindow).__harness!.interestHistory.slice(-1)[0],
    )
    expect(interest).toEqual(["", "dist", "dist/bundle.js"])
  })

  test("M1: a recreated root resets both the loaded tree and the preview", async ({ page }) => {
    await open(page)
    const preview = page.locator('section[aria-label="File preview"]')
    await page.getByRole("button", { name: "src" }).click()
    await page.getByRole("button", { name: "lib.ts" }).click()
    await expect(preview).toBeVisible()

    // 根目录被删除后重建：后端重新 arm 并下发 reset，前端整表重载、预览重读。
    await page.evaluate(() => {
      const harness = (window as unknown as HarnessWindow).__harness!
      harness.setDirs({
        "": [
          { name: "src", path: "src", is_dir: true },
          { name: "main.rs", path: "main.rs", is_dir: false },
        ],
        src: [
          { name: "lib.ts", path: "src/lib.ts", is_dir: false },
          { name: "new.ts", path: "src/new.ts", is_dir: false },
        ],
      })
      harness.setFileText("line 1\nrestored\nline 3\n")
      harness.emit("pi://project-files-changed", { project: "C:/demo", paths: [], reset: true })
    })
    await expect(page.getByRole("button", { name: "new.ts" })).toBeVisible()
    await expect(preview).toContainText("restored")
    // reset 丢弃旧缓存：根列表与已展开目录都重新拉取（不靠隐藏目录规避）。
    const listed = await page.evaluate(() =>
      (window as unknown as HarnessWindow)
        .__harness!.calls.filter(call => call.command === "list_project_directory")
        .map(call => call.args.path),
    )
    expect(listed.filter(path => path === "").length).toBeGreaterThanOrEqual(2)
    expect(listed).toContain("src")
  })

  test("unmounting the file tab releases the backend subscription", async ({ page }) => {
    await open(page)
    await page.evaluate(() => (window as unknown as HarnessWindow).__unmountHarness?.())
    await expect
      .poll(() => page.evaluate(() => (window as unknown as HarnessWindow).__harness!.calls.map(call => call.command)))
      .toContain("unwatch_project_files")
    const calls = await page.evaluate(() =>
      (window as unknown as HarnessWindow).__harness!.calls.map(call => call.command),
    )
    expect(calls.filter(command => command === "watch_project_files")).toHaveLength(1)
    expect(calls.filter(command => command === "unwatch_project_files")).toHaveLength(1)
  })
})
