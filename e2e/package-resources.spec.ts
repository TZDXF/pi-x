import { test, expect } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

let harness: VueHarness

const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import messages from '/src/i18n/locales/en.ts'
import PackageResourcePage from '/src/components/settings/packages/PackageResourcePage.vue'
import SettingsPage from '/src/components/SettingsPage.vue'
import { selectedResourcePackage } from '/src/components/settings/packages/selectedResourcePackage.ts'
import '/src/style.css'
selectedResourcePackage.value = { source: 'npm:pi-docs', scope: 'global' }
const settings = new URLSearchParams(location.search).has('settings')
const style = settings ? 'display:flex;flex-direction:column;height:100dvh;width:100%;padding:16px;overflow:hidden' : 'height:650px;width:1100px;padding:16px'
createApp({ render: () => h('div', { style }, [h(settings ? SettingsPage : PackageResourcePage)]) })
  .use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } })).use(createPinia()).mount('#app')
</script></body></html>`

const files = ["README.md", "docs/guides/Usage.MD", "docs/Reference.markdown", "src/index.ts", "assets/logo.png"]
const content: Record<string, string> = {
  "README.md":
    "# Package overview\n\n**Important** documentation.\n\n- First item\n- Second item\n\n```ts\nconst value = 1\n```",
  "docs/guides/Usage.MD": "# Usage guide\n\nNested **Markdown** document.",
  "docs/Reference.markdown": "# Reference\n\nAPI reference.",
}

test.beforeAll(async () => {
  harness = await startVueHarness({ name: "package-resources", port: 1462, html })
})

test.afterAll(async () => {
  await harness?.close()
})

test("shows only Markdown in a collapsible directory tree and renders original and translation", async ({
  page,
}, testInfo) => {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  const reads: string[] = []
  await page.route("**/api/invoke", async route => {
    const { command, args } = route.request().postDataJSON()
    let data: unknown = null
    if (command === "package_list_files") data = files
    if (command === "package_read_file") {
      reads.push(args.path)
      data = content[args.path]
    }
    if (command === "package_translate") data = "# Translated overview\n\n**Translated** documentation."
    await route.fulfill({ json: { data } })
  })
  await page.goto(harness.url)
  const tree = page.getByRole("tree")
  await expect(page.getByRole("heading", { name: "Package overview" })).toBeVisible()
  await expect(page.locator("strong", { hasText: "Important" })).toBeVisible()
  await expect(page.locator("li", { hasText: "First item" })).toBeVisible()
  await expect(page.locator("pre")).toContainText("const value = 1")
  await expect(tree.getByText("index.ts")).toHaveCount(0)
  await expect(tree.getByText("logo.png")).toHaveCount(0)
  await expect(tree.getByText("src", { exact: true })).toHaveCount(0)
  await expect(tree.getByText("assets", { exact: true })).toHaveCount(0)
  await expect(tree.getByText("Usage.MD", { exact: true })).toBeVisible()
  await expect(tree.getByText("Reference.markdown", { exact: true })).toBeVisible()

  await page.screenshot({ path: testInfo.outputPath("package-resources-preview.png") })
  await tree.getByRole("button", { name: "guides", exact: true }).click()
  await expect(tree.getByText("Usage.MD", { exact: true })).not.toBeVisible()
  expect(reads).toEqual(["README.md"])
  const filter = page.getByPlaceholder("Filter files by path…")
  await filter.fill("GUIDES/usage")
  await expect(tree.getByText("docs", { exact: true })).toBeVisible()
  await expect(tree.getByText("guides", { exact: true })).toBeVisible()
  await expect(tree.getByText("Usage.MD", { exact: true })).toBeVisible()
  await expect(tree.getByText("README.md", { exact: true })).toHaveCount(0)
  await tree.getByText("Usage.MD", { exact: true }).click()
  await expect(page.getByRole("heading", { name: "Usage guide" })).toBeVisible()
  expect(reads).toEqual(["README.md", "docs/guides/Usage.MD"])

  await page.getByRole("button", { name: "Translate", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Translated overview" })).toBeVisible()
  await expect(page.locator("strong", { hasText: "Translated" })).toBeVisible()
  await filter.fill("not-found")
  await expect(page.getByText("No matching files")).toBeVisible()
  await expect(page.getByRole("heading", { name: "Usage guide" })).toBeVisible()
  expect(errors).toEqual([])
})

test("shows the resource empty state when the package has no Markdown files", async ({ page }) => {
  const reads: string[] = []
  await page.route("**/api/invoke", async route => {
    const { command, args } = route.request().postDataJSON()
    if (command === "package_read_file") reads.push(args.path)
    await route.fulfill({ json: { data: command === "package_list_files" ? ["src/index.ts", "package.json"] : null } })
  })
  await page.goto(harness.url)
  await expect(page.getByText("No manageable resources found (package not installed yet or has none).")).toBeVisible()
  await expect(page.getByRole("tree")).toHaveCount(0)
  expect(reads).toEqual([])
})

test("ignores a stale file read after another Markdown document is selected", async ({ page }) => {
  let releaseRead!: () => void
  const slowRead = new Promise<void>(resolve => {
    releaseRead = resolve
  })
  let readFinished!: () => void
  const finished = new Promise<void>(resolve => {
    readFinished = resolve
  })
  await page.route("**/api/invoke", async route => {
    const { command, args } = route.request().postDataJSON()
    if (command === "package_list_files") {
      await route.fulfill({ json: { data: files } })
      return
    }
    if (command === "package_read_file" && args.path === "README.md") {
      await slowRead
      await route.fulfill({ json: { data: content[args.path] } })
      readFinished()
      return
    }
    await route.fulfill({ json: { data: content[args.path] ?? null } })
  })
  await page.goto(harness.url)
  await page.getByRole("tree").getByText("Usage.MD", { exact: true }).click()
  await expect(page.getByRole("heading", { name: "Usage guide" })).toBeVisible()
  const staleResponse = page.waitForResponse(response => response.request().postDataJSON()?.args?.path === "README.md")
  releaseRead()
  await finished
  await (await staleResponse).finished()
  await page.evaluate(
    () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
  await expect(page.getByRole("heading", { name: "Usage guide" })).toBeVisible()
  await expect(page.getByRole("heading", { name: "Package overview" })).toHaveCount(0)
})

test("keeps the settings resource browser within the window with independently scrolling panes", async ({
  page,
}, testInfo) => {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  const fixture = {
    files: Array.from({ length: 100 }, (_, i) => `docs/guides/document-${String(i).padStart(3, "0")}.md`),
    content: Array.from({ length: 80 }, (_, i) => `## Section ${i}\n\nParagraph ${i} with **Markdown** content.`).join(
      "\n\n",
    ),
  }
  await page.addInitScript(data => {
    Reflect.set(window, "isTauri", true)
    Reflect.set(window, "__TAURI_INTERNALS__", {
      invoke: async (command: string) => {
        if (command === "package_list_files") return data.files
        if (command === "package_read_file") return data.content
        throw new Error(`Unexpected command: ${command}`)
      },
    })
  }, fixture)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`${harness.url}?settings#/settings/package-resources`)
  await expect(page.getByRole("heading", { name: "Section 0", exact: true })).toBeVisible()
  const filesViewport = page.locator('[data-package-resource-files] [data-slot="scroll-area-viewport"]')
  const previewViewport = page.locator('[data-package-resource-preview] [data-slot="scroll-area-viewport"]')

  async function expectBoundedLayout() {
    await expect
      .poll(() =>
        page.evaluate(() => {
          const outer = document.querySelector(".settings-scroll")!
          const browser = document.querySelector("[data-package-resources]")!.getBoundingClientRect()
          return (
            document.documentElement.scrollHeight <= window.innerHeight &&
            outer.scrollHeight <= outer.clientHeight + 1 &&
            browser.bottom <= window.innerHeight
          )
        }),
      )
      .toBe(true)
    for (const viewport of [filesViewport, previewViewport]) {
      await expect
        .poll(() =>
          viewport.evaluate(element => {
            const box = element.getBoundingClientRect()
            return (
              element.clientHeight > 0 &&
              element.scrollHeight > element.clientHeight &&
              box.bottom <= window.innerHeight
            )
          }),
        )
        .toBe(true)
    }
  }

  await expectBoundedLayout()
  const toolbar = page.getByRole("button", { name: "Translate", exact: true })
  const before = await toolbar.boundingBox()
  await filesViewport.hover()
  await page.mouse.wheel(0, 500)
  await expect.poll(() => filesViewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  expect(await previewViewport.evaluate(element => element.scrollTop)).toBe(0)
  const filesScroll = await filesViewport.evaluate(element => element.scrollTop)
  await previewViewport.hover()
  await page.mouse.wheel(0, 500)
  await expect.poll(() => previewViewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  expect(await filesViewport.evaluate(element => element.scrollTop)).toBe(filesScroll)
  await expect(toolbar).toBeVisible()
  expect((await toolbar.boundingBox())?.y).toBe(before?.y)
  await expect(page.getByPlaceholder("Filter files by path…")).toBeVisible()

  await page.setViewportSize({ width: 1000, height: 500 })
  await expectBoundedLayout()
  await expect(toolbar).toBeVisible()
  await expect(page.getByPlaceholder("Filter files by path…")).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("package-resources-scroll.png") })
  expect(errors).toEqual([])
})
