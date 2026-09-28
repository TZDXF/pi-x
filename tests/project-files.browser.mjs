// PI_PLAYWRIGHT_MODULE may point to an existing Playwright installation.
// 验证项目文件页：预览在列表左侧；代码选区 → 批注面板 → 确认后进入待发送批注 store。
import assert from "node:assert/strict"
import { pathToFileURL } from "node:url"
import { createServer } from "vite"
const { chromium } = await import(
  process.env.PI_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PI_PLAYWRIGHT_MODULE).href : "playwright"
)

const fileText = Array.from({ length: 20 }, (_, i) => `const value_${i + 1} = ${i + 1} // content`).join("\n")
const dirs = {
  "": [
    { name: "src", path: "src", is_dir: true },
    { name: "main.rs", path: "main.rs", is_dir: false },
  ],
  src: [{ name: "lib.ts", path: "src/lib.ts", is_dir: false }],
}
const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import messages from '/src/i18n/locales/en.ts'
import ProjectFiles from '/src/components/ProjectFiles.vue'
import '/src/style.css'
const pinia = createPinia()
window.__pinia = pinia
createApp({ render: () => h('div', { style: 'display:flex;height:650px;width:1100px' }, [h(ProjectFiles, { project: 'C:/demo' })]) })
  .use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } })).use(pinia).mount('#app')
</script></body></html>`

const server = await createServer({
  server: { port: 1443, strictPort: true },
  plugins: [
    {
      name: "project-files-fixture",
      configureServer(server) {
        server.middlewares.use("/__project_files_test", async (req, res, next) => {
          try {
            res.setHeader("Content-Type", "text/html")
            res.end(await server.transformIndexHtml("/__project_files_test", html))
          } catch (e) {
            next(e)
          }
        })
      },
    },
  ],
})
await server.listen()
const browser = await chromium.launch({ channel: process.env.PI_BROWSER_CHANNEL || "msedge", headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
const errors = []
page.on("pageerror", error => errors.push(error.message))
await page.addInitScript(() => {
  window.isTauri = true
  window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      if (command === "list_project_directory") return dirs[args.path ?? ""] ?? []
      if (command === "read_file_preview")
        return { kind: "text", text: fileText, truncated: false, mime: null, data: null }
      throw Error("unexpected command " + command)
    },
  }
})
try {
  await page.goto("http://localhost:1443/__project_files_test")
  await page.getByRole("button", { name: "main.rs" }).click()
  const preview = page.locator('section[aria-label="File preview"]')
  await preview.waitFor()
  // 预览与列表交换后：预览在左，文件列表在右。
  const previewX = (await preview.boundingBox()).x
  const listX = (await page.locator('[data-slot="scroll-area-viewport"]').first().boundingBox()).x
  assert.ok(previewX < listX, `preview x ${previewX} should be left of list x ${listX}`)

  // 选中第 5–7 行（锚点落在行内 code 元素上），点批注按钮后面板应给出该范围。
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-line]")]
    const code = row => row.querySelector("code") ?? row
    const range = document.createRange()
    range.setStart(code(rows[4]).firstChild, 0)
    range.setEnd(code(rows[6]).firstChild, 3)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event("selectionchange"))
  })
  await page.getByRole("button", { name: "Annotate", exact: true }).click()
  await page.getByText("Lines 5-7").waitFor()
  await page.getByPlaceholder("Write a comment…").fill("请检查这里的边界条件")
  await page.getByRole("button", { name: "Add comment", exact: true }).click()
  const comments = await page.evaluate(() => window.__pinia.state.value.codeComments.comments)
  assert.equal(comments.length, 1)
  assert.deepEqual(
    { ...comments[0], id: undefined },
    {
      id: undefined,
      path: "main.rs",
      startLine: 5,
      endLine: 7,
      selectedText: fileText.split("\n").slice(4, 7).join("\n"),
      comment: "请检查这里的边界条件",
    },
  )
  // 已批注的行保持高亮，批注面板关闭。
  assert.ok((await page.locator('[data-line="5"]').getAttribute("class")).includes("bg-amber-500/15"))
  assert.equal(await page.getByPlaceholder("Write a comment…").count(), 0)

  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  await server.close()
}
