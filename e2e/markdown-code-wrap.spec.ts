import { test, expect, type Page } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

// 回归（TZD-133）：Markdown 代码块 header 增加「换行」按钮，点击一次对**所有**代码块
// 立即生效，并把偏好写进 ~/.pix/config.json；重新加载（模拟重启）后按钮状态与换行
// 行为都从配置恢复。这里用真实 Vite 模块图渲染多个独立的 MessageResponse，点击其中
// 一个代码块按钮后检查**其它**代码块（含全屏弹层）的 pre 也变了，以此证明是全局切换。
//
// 审查（P2）回归：
// - 全屏弹层被 teleport 到 `<Markdown>` 根之外，根节点上的类管不到它；现在换行状态写在
//   根元素属性上（`data-markdown-code-wrap`），全屏与内嵌永远同态，且全屏里只有一个换行按钮。
// - 迟到的旧配置回执不得反转较新的本地切换：写入会登记为「待确认」，值不匹配的旧快照跳过。
// - 重载用例必须先确认持久化（主机真的收到了写入）再重载。

let harness: VueHarness | null = null

/** 一条足够长的单行（约 2 KB），用于验证不换行时的横向溢出。 */
const longLine = "const longLine = '" + "abcdef".repeat(340) + "'"
/** 三个代码块的内容以 JSON 内联进 harness，避免反引号/反斜杠被 HTML 脚本提前截断。 */
const snippets = {
  first: "Short block\n\n```ts\nconst a = 1\n```",
  second: "Second block\n\n```ts\nconst b = 2\n```",
  long: `Long block\n\n\`\`\`ts\n${longLine}\n\`\`\``,
}

const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import messages from '/src/i18n/locales/en.ts'
import MessageResponse from '/src/components/ai-elements/message/MessageResponse.vue'
import { initializeConfigPreferences } from '/src/lib/configPreference.ts'
import '/src/style.css'

const snippets = ${JSON.stringify(snippets)}

await initializeConfigPreferences()
createApp({ render: () => h('main', { style: 'padding:16px;width:900px' }, [
  h('section', { 'data-message': 'first' }, [h(MessageResponse, { content: snippets.first, mode: 'static' })]),
  h('section', { 'data-message': 'second' }, [h(MessageResponse, { content: snippets.second, mode: 'static' })]),
  h('section', { 'data-message': 'long' }, [h(MessageResponse, { content: snippets.long, mode: 'static' })]),
]) }).use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } })).use(createPinia()).mount('#app')
</script></body></html>`

test.beforeAll(async () => {
  harness = await startVueHarness({ name: "markdown-code-wrap", port: 1545, html })
})

test.afterAll(async () => {
  await harness?.close()
})

interface HostOptions {
  /** 首次加载时写入的初值（重载后以 sessionStorage 里最后一次保存为准）。 */
  initial?: Record<string, string>
  /** Hold `pi://app-config-changed` events so the test can deliver them out of order. */
  delayEvents?: boolean
}

/** 主机配置（config.json 的 preferences 段）用 sessionStorage 模拟：同一标签页重载后仍在。 */
async function installHostConfig(page: Page, options: HostOptions = {}) {
  await page.addInitScript((config: HostOptions) => {
    const harnessWindow = window as Window & {
      isTauri: boolean
      __TAURI_INTERNALS__?: Record<string, unknown>
      __TAURI_EVENT_PLUGIN_INTERNALS__?: Record<string, unknown>
      __writes?: { key: string; value: string }[]
      __pendingEvents?: number
      __releaseEvent?: (index: number) => void
      __flushEvents?: () => void
    }
    const overrides = config.initial ?? {}
    const storedPreferences = (): Record<string, string> => {
      const map: Record<string, string> = {}
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i)!
        if (key.startsWith("pref:")) map[key.slice(5)] = sessionStorage.getItem(key)!
      }
      return map
    }
    // 首次进入（或重载前没有保存过）时写入测试指定的初值；重载后读回最后一次保存。
    for (const [key, value] of Object.entries(overrides)) {
      if (sessionStorage.getItem(`pref:${key}`) === null) sessionStorage.setItem(`pref:${key}`, value)
    }
    const readPreferences = (): Record<string, string> => ({ ...storedPreferences() })
    const callbacks = new Map<number, (payload: unknown) => void>()
    const held: Array<() => void> = []
    let nextId = 1
    harnessWindow.isTauri = true
    harnessWindow.__writes = []
    harnessWindow.__pendingEvents = 0
    harnessWindow.__flushEvents = () => {
      while (held.length > 0) held.shift()!()
      harnessWindow.__pendingEvents = 0
    }
    harnessWindow.__releaseEvent = (index: number) => {
      held.splice(index, 1)[0]?.()
      harnessWindow.__pendingEvents = held.length
    }
    harnessWindow.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined }
    const internals = {
      transformCallback: (callback: (payload: unknown) => void) => {
        const id = nextId++
        callbacks.set(id, callback)
        return id
      },
      invoke: async (command: string, args: Record<string, string>) => {
        if (command === "app_config_get") return { preferences: readPreferences() }
        if (command === "app_preference_set") {
          harnessWindow.__writes!.push({ key: args.key, value: args.value })
          sessionStorage.setItem(`pref:${args.key}`, args.value)
          const snapshot = readPreferences()
          const emit = () => {
            for (const callback of callbacks.values())
              callback({ event: "pi://app-config-changed", id: nextId, payload: { preferences: snapshot } })
          }
          if (config.delayEvents) {
            held.push(emit)
            harnessWindow.__pendingEvents = held.length
          } else emit()
          return null
        }
        if (command === "plugin:event|listen") return nextId
        if (command === "plugin:event|unlisten") return null
        return null
      },
    }
    Reflect.set(harnessWindow, "__TAURI_INTERNALS__", internals)
  }, options)
}

const wrapButtonName = (on: boolean) =>
  on
    ? "Turn off code block wrapping (applies to all code blocks)"
    : "Turn on code block wrapping (applies to all code blocks)"

const inlineBlocks = (page: Page) => page.locator('#app pre[data-stream-markdown="code"]')

async function inlineWrapState(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('#app pre[data-stream-markdown="code"]')).map(
      element => getComputedStyle(element).whiteSpace,
    ),
  )
}

async function writes(page: Page) {
  return page.evaluate(() => Reflect.get(window, "__writes") as { key: string; value: string }[])
}

/**
 * 等主机真的收到这次写入（而不是只等 UI 的乐观更新）之后才允许重载/断言。
 * 默认要求写入恰好只有这一次；连点场景用 `last` 只校验最后一笔。
 */
async function expectPersisted(page: Page, value: string, options: { last?: boolean } = {}) {
  if (options.last) {
    await expect
      .poll(async () => {
        const records = await writes(page)
        return records[records.length - 1]?.value
      })
      .toBe(value)
  } else {
    await expect.poll(async () => (await writes(page)).map(write => write.value)).toEqual([value])
  }
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("pref:markdownCodeWrap"))).toBe(value)
}

test("one click wraps every markdown code block and persists the preference", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await installHostConfig(page, { initial: { markdownCodeWrap: "1" } })
  await page.goto(harness!.url)

  await expect(inlineBlocks(page)).toHaveCount(3)
  // 默认换行：所有代码块都是 pre-wrap，且没有横向溢出。
  expect(await inlineWrapState(page)).toEqual(["pre-wrap", "pre-wrap", "pre-wrap"])
  expect(
    await page
      .locator('[data-message="long"] pre')
      .evaluate((element: HTMLElement) => element.scrollWidth <= element.clientWidth),
  ).toBe(true)

  // 只在第一个消息体的代码块上点一次。
  await page
    .locator('[data-message="first"]')
    .getByRole("button", { name: wrapButtonName(true) })
    .click()
  // 全局即时生效：所有代码块都变成 nowrap，且按钮文案整体切换。
  await expect.poll(() => inlineWrapState(page)).toEqual(["pre", "pre", "pre"])
  expect(await page.getByRole("button", { name: wrapButtonName(false) }).count()).toBe(3)
  expect(await page.getByRole("button", { name: wrapButtonName(true) }).count()).toBe(0)

  // 偏好写入主机配置（~/.pix/config.json 的 preferences 段），且确认写入完成后才结束用例。
  await expectPersisted(page, "0")
  expect(await writes(page)).toEqual([{ key: "markdownCodeWrap", value: "0" }])

  expect(errors).toEqual([])
})

test("a reload restores the saved wrapping preference", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await installHostConfig(page, { initial: { markdownCodeWrap: "1" } })
  await page.goto(harness!.url)
  await expect(inlineBlocks(page)).toHaveCount(3)

  await page
    .getByRole("button", { name: wrapButtonName(true) })
    .first()
    .click()
  await expect.poll(() => inlineWrapState(page)).toEqual(["pre", "pre", "pre"])
  // 关键：先确认持久化（主机收到写入且已落盘），再重载，避免读到旧的 pre-wrap。
  await expectPersisted(page, "0")

  // 模拟重启：同一标签页重新加载，配置从主机（sessionStorage 模拟）重新读取。
  await page.reload()
  await expect(inlineBlocks(page)).toHaveCount(3)
  await expect.poll(() => inlineWrapState(page)).toEqual(["pre", "pre", "pre"])
  expect(await page.getByRole("button", { name: wrapButtonName(false) }).count()).toBe(3)

  // 再切回换行，同样立即作用于所有代码块。
  await page
    .locator('[data-message="second"]')
    .getByRole("button", { name: wrapButtonName(false) })
    .click()
  await expect.poll(() => inlineWrapState(page)).toEqual(["pre-wrap", "pre-wrap", "pre-wrap"])
  await expectPersisted(page, "1")

  expect(errors).toEqual([])
})

test("fullscreen shares the wrap state with the inline block and shows one wrap toggle", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await installHostConfig(page, { initial: { markdownCodeWrap: "1" } })
  await page.goto(harness!.url)
  const message = page.locator('[data-message="long"]')
  await expect(message.locator('[data-stream-markdown="code"]')).toHaveCSS("white-space", "pre-wrap")

  await message.getByRole("button", { name: /maximize/i }).click()
  const modal = page.locator('[data-stream-markdown="modal"]')
  const fullscreenPre = modal.locator('[data-stream-markdown="code"]')
  await expect(fullscreenPre).toBeVisible()
  // 全屏弹层不在 #app 内（渲染器 teleport 到 overlay 容器 / body），根节点上的类管不到它。
  expect(await fullscreenPre.evaluate((element: HTMLElement) => !!element.closest("#app"))).toBe(false)

  // 全屏与内嵌同态：都换行，且长行没有横向溢出。
  await expect(fullscreenPre).toHaveCSS("white-space", "pre-wrap")
  await expect(fullscreenPre).toHaveCSS("overflow-wrap", "anywhere")
  expect(await fullscreenPre.evaluate((element: HTMLElement) => element.scrollWidth <= element.clientWidth)).toBe(true)
  // 全屏里只保留一个换行按钮（渲染器会把已定制的列表再喂给 customize 一次）。
  await expect(modal.getByRole("button", { name: wrapButtonName(true) })).toHaveCount(1)
  await expect(modal.getByRole("button", { name: wrapButtonName(false) })).toHaveCount(0)

  // 从全屏点一次：全屏与内嵌一起变 nowrap，全屏里仍只有一个按钮。
  await modal.getByRole("button", { name: wrapButtonName(true) }).click()
  await expect(fullscreenPre).toHaveCSS("white-space", "pre")
  await expect(message.locator('[data-stream-markdown="code"]')).toHaveCSS("white-space", "pre")
  await expect.poll(() => inlineWrapState(page)).toEqual(["pre", "pre", "pre"])
  await expect(modal.getByRole("button", { name: wrapButtonName(false) })).toHaveCount(1)
  await expect(modal.getByRole("button", { name: wrapButtonName(true) })).toHaveCount(0)
  await expectPersisted(page, "0")

  expect(errors).toEqual([])
})

test("a late stale config event never reverses the newest local toggle", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await installHostConfig(page, { initial: { markdownCodeWrap: "1" }, delayEvents: true })
  await page.goto(harness!.url)
  const message = page.locator('[data-message="first"]')
  await expect(inlineBlocks(page)).toHaveCount(3)

  // 连点「关 → 开」：写入按顺序是 0、1，但主机回执都还在路上。
  await message.getByRole("button", { name: wrapButtonName(true) }).click()
  await message.getByRole("button", { name: wrapButtonName(false) }).click()
  await expect.poll(() => inlineWrapState(page)).toEqual(["pre-wrap", "pre-wrap", "pre-wrap"])
  await expect.poll(async () => (await writes(page)).map(write => write.value)).toEqual(["0", "1"])

  // 投递第一笔的旧快照（值是 0）。它必须被忽略：用户最后选的是「开」，三个代码块
  // 都保持换行，按钮也全部维持「关闭换行」的文案。
  await page.evaluate(() => Reflect.get(window, "__releaseEvent")!(0))
  await expect.poll(() => inlineWrapState(page)).toEqual(["pre-wrap", "pre-wrap", "pre-wrap"])
  expect(await page.getByRole("button", { name: wrapButtonName(true) }).count()).toBe(3)
  expect(await page.getByRole("button", { name: wrapButtonName(false) }).count()).toBe(0)

  // 最后补上第二笔回执（1），状态维持不变。
  await page.evaluate(() => Reflect.get(window, "__flushEvents")!())
  await expect.poll(() => inlineWrapState(page)).toEqual(["pre-wrap", "pre-wrap", "pre-wrap"])
  expect(await page.getByRole("button", { name: wrapButtonName(true) }).count()).toBe(3)
  await expectPersisted(page, "1", { last: true })

  expect(errors).toEqual([])
})
