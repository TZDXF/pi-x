import { test, expect, type Page } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

interface DirectoryEntry {
  name: string
  path: string
  is_dir: boolean
}

type DirectoryMap = Record<string, DirectoryEntry[]>

interface HarnessState {
  dirs: DirectoryMap
  text: Record<string, string>
  /** Paths whose next listing should hang until `releaseList` is called. */
  holdNext: string[]
  calls: { command: string; args: Record<string, unknown> }[]
  /** Latest interest published per subscriber token. */
  interest: Record<string, string[]>
  /** Held list requests, in call order. */
  held: { path: string; project: string; resolve: (entries: DirectoryEntry[]) => void; reject: (err: Error) => void }[]
  watches: string[]
  unwatches: string[]
}

interface HarnessWindow {
  isTauri: boolean
  __TAURI_INTERNALS__?: {
    invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>
    transformCallback: (callback: (payload: unknown) => void, once?: boolean) => number
  }
  __TAURI_EVENT_PLUGIN_INTERNALS__?: { unregisterListener: (event: string, id: number) => void }
  __harness?: {
    emit: (event: string, payload: unknown) => void
    state: HarnessState
    setDirs: (dirs: DirectoryMap) => void
    setText: (text: Record<string, string>) => void
    holdNext: (paths: string[]) => void
    releaseHeld: (index: number, entries?: DirectoryEntry[]) => void
    failHeld: (index: number, message: string) => void
  }
  __unmountA?: () => void
  __unmountB?: () => void
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

const html = `<!doctype html><html><body>
<div id="a" style="display:flex;width:700px;height:520px"></div>
<div id="b" style="display:flex;width:700px;height:520px"></div>
<script type="module">
import { createApp, h } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import messages from '/src/i18n/locales/en.ts'
import ProjectFiles from '/src/components/ProjectFiles.vue'
import '/src/style.css'
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: messages } })
const pinia = createPinia()
const appA = createApp({ render: () => h(ProjectFiles, { project: 'C:/demo' }) })
appA.use(i18n).use(pinia).mount('#a')
const appB = createApp({ render: () => h(ProjectFiles, { project: 'C:/demo' }) })
appB.use(i18n).use(pinia).mount('#b')
window.__unmountA = () => appA.unmount()
window.__unmountB = () => appB.unmount()
</script></body></html>`

test.use({ viewport: { width: 1500, height: 1000 } })

test.describe("project file sync", () => {
  let harness!: VueHarness

  test.beforeAll(async () => {
    harness = await startVueHarness({ name: "project-file-sync", port: 1454, html })
  })

  test.afterAll(async () => {
    await harness.close()
  })

  /**
   * Fake the Tauri IPC surface with an in-memory project. Two `ProjectFiles`
   * instances are mounted (two files tabs on the same project) and every
   * subscription keeps its own token, exactly like the real backend contract:
   * `watch`/`unwatch`/`set_project_files_interest` carry the token, and the
   * watcher reports the union of the scopes it holds.
   */
  async function open(page: Page) {
    await page.addInitScript(
      fixture => {
        const harnessWindow = window as unknown as HarnessWindow
        harnessWindow.isTauri = true
        const callbacks = new Map<number, (payload: unknown) => void>()
        let nextId = 1
        const state: HarnessState = {
          dirs: fixture.dirs,
          text: {},
          holdNext: [],
          calls: [],
          interest: {},
          held: [],
          watches: [],
          unwatches: [],
        }
        for (const path of Object.keys(fixture.dirs)) {
          state.text[path] = `line 1
${path || "root"}
line 3
`
        }
        harnessWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined }
        const api = {
          state,
          emit: (event: string, payload: unknown) => {
            for (const callback of callbacks.values()) callback({ event, id: nextId, payload })
          },
          setDirs: (dirs: DirectoryMap) => {
            state.dirs = dirs
          },
          setText: (next: Record<string, string>) => {
            Object.assign(state.text, next)
          },
          holdNext: (paths: string[]) => {
            state.holdNext = paths
          },
          releaseHeld: (index: number, entries?: DirectoryEntry[]) => {
            const held = state.held[index]
            if (!held) throw new Error("no held request at " + index)
            state.held.splice(index, 1)
            held.resolve(entries ?? state.dirs[held.path] ?? [])
          },
          failHeld: (index: number, message: string) => {
            const held = state.held[index]
            if (!held) throw new Error("no held request at " + index)
            state.held.splice(index, 1)
            held.reject(new Error(message))
          },
        }
        harnessWindow.__harness = api
        Reflect.set(harnessWindow, "__TAURI_INTERNALS__", {
          transformCallback: (callback: (payload: unknown) => void) => {
            const id = nextId++
            callbacks.set(id, callback)
            return id
          },
          invoke: async (command: string, args: Record<string, unknown>) => {
            state.calls.push({ command, args })
            const path = (args.path as string) ?? ""
            if (command === "list_project_directory") {
              if (state.holdNext.includes(path)) {
                state.holdNext = state.holdNext.filter(item => item !== path)
                return new Promise((resolve, reject) => {
                  state.held.push({ path, project: args.project as string, resolve, reject })
                })
              }
              return state.dirs[path] ?? []
            }
            if (command === "read_file_preview") {
              const previewPath = args.path as string
              return {
                kind: "text",
                text:
                  state.text[previewPath] ??
                  `line 1
${previewPath}
line 3
`,
                truncated: false,
                mime: null,
                data: null,
              }
            }
            if (command === "watch_project_files") {
              state.watches.push(args.subscriber as string)
              return null
            }
            if (command === "unwatch_project_files") {
              state.unwatches.push(args.subscriber as string)
              return null
            }
            if (command === "set_project_files_interest") {
              state.interest[args.subscriber as string] = args.paths as string[]
              return null
            }
            if (command === "plugin:event|listen") return 1
            if (command === "plugin:event|unlisten") return null
            throw Error("unexpected command " + command)
          },
        })
      },
      { dirs: initialDirs },
    )
    await page.goto(harness.url)
    await expect(page.getByRole("button", { name: "main.rs" }).first()).toBeVisible()
  }

  const state = (page: Page) =>
    page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as HarnessWindow).__harness!.state)))

  test("two files tabs keep independent scopes and both stay in sync", async ({ page }) => {
    await open(page)
    const tabA = page.locator("#a")
    const tabB = page.locator("#b")

    // 两个页签展开不同目录、打开不同文件。
    await tabA.getByRole("button", { name: "src" }).click()
    await tabA.getByRole("button", { name: "lib.ts" }).click()
    await tabB.getByRole("button", { name: "dist" }).click()
    await tabB.getByRole("button", { name: "bundle.js" }).click()
    await expect(tabA.locator('section[aria-label="File preview"]')).toContainText("src/lib.ts")
    await expect(tabB.locator('section[aria-label="File preview"]')).toContainText("dist/bundle.js")

    // 每个页签用自己的订阅标识上报关注范围，互不覆盖。
    const snapshot = await state(page)
    expect(snapshot.watches).toHaveLength(2)
    expect(new Set(snapshot.watches).size).toBe(2)
    const scopes = snapshot.watches.map((token: string) => snapshot.interest[token])
    expect(scopes).toEqual(
      expect.arrayContaining([
        ["", "src", "src/lib.ts"],
        ["", "dist", "dist/bundle.js"],
      ]),
    )

    // 后端按并集上报：两个页签都要各自同步（H1 回归）。
    await page.evaluate(() => {
      const harness = (window as unknown as HarnessWindow).__harness!
      harness.setDirs({
        "": [
          { name: "dist", path: "dist", is_dir: true },
          { name: "src", path: "src", is_dir: true },
          { name: "main.rs", path: "main.rs", is_dir: false },
        ],
        src: [
          { name: "lib.ts", path: "src/lib.ts", is_dir: false },
          { name: "added.ts", path: "src/added.ts", is_dir: false },
        ],
        dist: [
          { name: "bundle.js", path: "dist/bundle.js", is_dir: false },
          { name: "report.txt", path: "dist/report.txt", is_dir: false },
        ],
      })
      harness.setText({
        "src/lib.ts": "line 1\nsrc updated\nline 3\n",
        "dist/bundle.js": "line 1\ndist updated\nline 3\n",
      })
      harness.emit("pi://project-files-changed", {
        project: "C:/demo",
        paths: ["src/lib.ts", "dist/bundle.js"],
        reset: false,
      })
    })
    await expect(tabA.locator('section[aria-label="File preview"]')).toContainText("src updated")
    await expect(tabB.locator('section[aria-label="File preview"]')).toContainText("dist updated")
    await expect(tabA.getByRole("button", { name: "added.ts" })).toBeVisible()
    await expect(tabB.getByRole("button", { name: "report.txt" })).toBeVisible()
  })

  test("closing one tab only releases its own subscription", async ({ page }) => {
    await open(page)
    const tabA = page.locator("#a")
    const tabB = page.locator("#b")
    await tabA.getByRole("button", { name: "src" }).click()
    await tabB.getByRole("button", { name: "dist" }).click()

    const before = await state(page)
    const tokenA = before.watches[0]
    const tokenB = before.watches[1]

    await page.evaluate(() => (window as unknown as HarnessWindow).__unmountA?.())
    await expect.poll(async () => (await state(page)).unwatches).toEqual([tokenA])

    // 剩下的页签继续同步。
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
          { name: "still.txt", path: "dist/still.txt", is_dir: false },
        ],
      })
      harness.emit("pi://project-files-changed", { project: "C:/demo", paths: ["dist/still.txt"], reset: false })
    })
    await expect(tabB.getByRole("button", { name: "still.txt" })).toBeVisible()
    const after = await state(page)
    expect(after.unwatches).toEqual([tokenA])
    expect(after.unwatches).not.toContain(tokenB)
  })

  test("M2: a visible directory outside the initial scope starts syncing once loaded", async ({ page }) => {
    await open(page)
    const tabA = page.locator("#a")
    const preview = tabA.locator('section[aria-label="File preview"]')

    await tabA.getByRole("button", { name: "dist" }).click()
    await tabA.getByRole("button", { name: "bundle.js" }).click()
    await expect(preview).toBeVisible()
    await expect
      .poll(async () => {
        const snapshot = await state(page)
        return snapshot.interest[snapshot.watches[0]]
      })
      .toEqual(["", "dist", "dist/bundle.js"])

    await page.evaluate(() => {
      const harness = (window as unknown as HarnessWindow).__harness!
      harness.setText({ "dist/bundle.js": "line 1\nchanged\nline 3\n" })
      harness.emit("pi://project-files-changed", { project: "C:/demo", paths: ["dist/bundle.js"], reset: false })
    })
    await expect(preview).toContainText("changed")

    // 收起目录后关注范围收窄，不再为不可见子树请求事件（只保留根与打开的文件）。
    await tabA.getByRole("button", { name: "dist" }).click()
    await expect
      .poll(async () => {
        const snapshot = await state(page)
        return snapshot.interest[snapshot.watches[0]]
      })
      .toEqual(["", "dist/bundle.js"])
    // 再展开时重新拉取列表，收起期间的变更不会留下陈旧子项。
    await tabA.getByRole("button", { name: "dist" }).click()
    await expect(tabA.getByRole("button", { name: "bundle.js" })).toBeVisible()
  })

  test("M1 / L1: a reset discards a response still in flight from the old generation", async ({ page }) => {
    await open(page)
    const tabA = page.locator("#a")
    await tabA.getByRole("button", { name: "src" }).click()
    await expect(tabA.getByRole("button", { name: "lib.ts" })).toBeVisible()

    // 1) 普通变更触发的 src 重拉被挂起（属于 reset 之前的世代）。
    await page.evaluate(() => {
      const harness = (window as unknown as HarnessWindow).__harness!
      harness.holdNext(["src"])
      harness.emit("pi://project-files-changed", { project: "C:/demo", paths: ["src/lib.ts"], reset: false })
    })
    await expect.poll(async () => (await state(page)).held.length).toBeGreaterThan(0)

    // 2) 根目录重建：reset 作废所有在途请求，并按根与已展开目录重新加载。
    await page.evaluate(() => {
      const harness = (window as unknown as HarnessWindow).__harness!
      harness.setDirs({
        "": [
          { name: "src", path: "src", is_dir: true },
          { name: "main.rs", path: "main.rs", is_dir: false },
          { name: "fresh.ts", path: "fresh.ts", is_dir: false },
        ],
        src: [
          { name: "lib.ts", path: "src/lib.ts", is_dir: false },
          { name: "new.ts", path: "src/new.ts", is_dir: false },
        ],
      })
      harness.emit("pi://project-files-changed", { project: "C:/demo", paths: [], reset: true })
    })
    await expect(tabA.getByRole("button", { name: "new.ts" })).toBeVisible()
    await expect(tabA.getByRole("button", { name: "fresh.ts" })).toBeVisible()

    // 3) 旧世代的响应这时才返回，必须被丢弃，不得污染已重建的列表。
    await page.evaluate(() => {
      const harness = (window as unknown as HarnessWindow).__harness!
      harness.releaseHeld(0, [{ name: "stale.ts", path: "stale.ts", is_dir: false }])
    })
    await page.waitForTimeout(400)
    await expect(tabA.getByRole("button", { name: "stale.ts" })).toHaveCount(0)
    await expect(tabA.getByRole("button", { name: "new.ts" })).toBeVisible()
    const listed = await state(page)
    expect(listed.held).toHaveLength(0)
  })

  test("L2: a deleted loaded directory drops its stale children", async ({ page }) => {
    await open(page)
    const tabA = page.locator("#a")
    await tabA.getByRole("button", { name: "src" }).click()
    await expect(tabA.getByRole("button", { name: "lib.ts" })).toBeVisible()

    // 目录被删除：列表请求失败，陈旧子项必须从树上消失，只留错误提示。
    await page.evaluate(() => {
      const harness = (window as unknown as HarnessWindow).__harness!
      harness.holdNext(["src"])
      harness.setDirs({
        "": [
          { name: "dist", path: "dist", is_dir: true },
          { name: "src", path: "src", is_dir: true },
          { name: "main.rs", path: "main.rs", is_dir: false },
        ],
        src: [],
        dist: [{ name: "bundle.js", path: "dist/bundle.js", is_dir: false }],
      })
      harness.emit("pi://project-files-changed", { project: "C:/demo", paths: ["src"], reset: false })
    })
    await expect.poll(async () => (await state(page)).held.length).toBeGreaterThan(0)
    await page.evaluate(() => {
      const harness = (window as unknown as HarnessWindow).__harness!
      harness.failHeld(0, 'PIXERR:{"code":"previewReadFailed","fallback":"目录不可读"}')
    })
    await expect(tabA.getByRole("button", { name: "lib.ts" })).toHaveCount(0)
    await expect(tabA.getByRole("alert")).toBeVisible()
  })

  test("final teardown releases every remaining subscription", async ({ page }) => {
    await open(page)
    const before = await state(page)
    expect(before.watches).toHaveLength(2)
    await page.evaluate(() => {
      const harness = window as unknown as HarnessWindow
      harness.__unmountA?.()
      harness.__unmountB?.()
    })
    await expect.poll(async () => (await state(page)).unwatches.length).toBe(2)
    const after = await state(page)
    expect(new Set(after.unwatches)).toEqual(new Set(before.watches))
  })
})
