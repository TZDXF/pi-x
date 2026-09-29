import { test, expect, type Page } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

interface ProjectDirectoryEntry {
  name: string
  path: string
  is_dir: boolean
}

type ProjectDirectoryMap = Record<string, ProjectDirectoryEntry[]>

interface ProjectFilesInvokeArguments {
  path?: string
}

interface ProjectFilesWindow {
  isTauri: boolean
  __TAURI_INTERNALS__?: {
    invoke: (command: string, args: ProjectFilesInvokeArguments) => Promise<unknown>
  }
  __pinia?: {
    state?: {
      value?: {
        codeComments?: {
          comments?: CodeComment[]
        }
      }
    }
  }
}

interface CodeComment {
  id?: string
  path: string
  startLine: number
  endLine: number
  selectedText: string
  comment: string
}

interface ElementBox {
  x: number
  y: number
  width: number
  height: number
}

interface ProjectFilesFixture {
  dirs: ProjectDirectoryMap
  fileText: string
}

const fileText = Array.from({ length: 20 }, (_, i) => `const value_${i + 1} = ${i + 1} // content`).join("\n")
const dirs: ProjectDirectoryMap = {
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

test.use({ viewport: { width: 1280, height: 1000 } })

test.describe("project files", () => {
  let harness!: VueHarness

  test.beforeAll(async () => {
    harness = await startVueHarness({ name: "project-files", port: 1453, html })
  })

  test.afterAll(async () => {
    await harness.close()
  })

  test("previews files and stores selected annotations", async ({ page }: { page: Page }) => {
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))

    const fixture: ProjectFilesFixture = { dirs, fileText }
    await page.addInitScript((projectFixture: ProjectFilesFixture) => {
      const projectWindow = window as Window & typeof globalThis & ProjectFilesWindow
      projectWindow.isTauri = true
      const internals = {
        invoke: async (command: string, args: ProjectFilesInvokeArguments): Promise<unknown> => {
          if (command === "list_project_directory") {
            return projectFixture.dirs[args.path ?? ""] ?? []
          }
          if (command === "read_file_preview") {
            return { kind: "text", text: projectFixture.fileText, truncated: false, mime: null, data: null }
          }
          throw Error("unexpected command " + command)
        },
      }
      Reflect.set(projectWindow, "__TAURI_INTERNALS__", internals)
    }, fixture)

    await page.goto(harness.url)
    await page.getByRole("button", { name: "main.rs" }).click()
    const preview = page.locator('section[aria-label="File preview"]')
    await expect(preview).toBeVisible()

    // 预览与列表交换后：预览在左，文件列表在右。
    const previewX = requireX(await preview.boundingBox(), "file preview")
    const listX = requireX(await page.locator('[data-slot="scroll-area-viewport"]').first().boundingBox(), "file list")
    expect(previewX, `preview x ${previewX} should be left of list x ${listX}`).toBeLessThan(listX)

    // 选中第 5–7 行（锚点落在行内 code 元素上），点批注按钮后面板应给出该范围。
    await selectPreviewLines(page)
    await page.getByRole("button", { name: "Annotate", exact: true }).click()
    await expect(page.getByText("Lines 5-7")).toBeVisible()
    await page.getByPlaceholder("Write a comment…").fill("请检查这里的边界条件")
    // 输入框获得焦点可能清除 DOM selection；重新套用同一段选区，模拟用户在预览中保持选中的流程。
    await selectPreviewLines(page)
    const addComment = page.getByRole("button", { name: "Add comment", exact: true })
    await expect(addComment).toBeEnabled()
    await addComment.click()

    const comments = await page.evaluate(() => {
      const comments = (window as Window & typeof globalThis & ProjectFilesWindow).__pinia?.state?.value?.codeComments
        ?.comments
      if (!comments) throw new Error("code comment store state is unavailable")
      return comments
    })
    expect(comments).toHaveLength(1)
    expect(comments.map(comment => ({ ...comment, id: undefined }))).toEqual([
      {
        path: "main.rs",
        startLine: 5,
        endLine: 7,
        selectedText: fileText.split("\n").slice(4, 7).join("\n"),
        comment: "请检查这里的边界条件",
      },
    ])

    // 已批注的行保持高亮，批注面板关闭。
    const lineClass = await page.locator('[data-line="5"]').getAttribute("class")
    expect(lineClass, "annotated line remains highlighted").toContain("bg-amber-500/15")
    await expect(page.getByPlaceholder("Write a comment…")).toHaveCount(0)

    expect(errors).toEqual([])
  })
})

/** Select characters 0-2 on preview lines 5 and 7 using the highlighted text nodes. */
async function selectPreviewLines(page: Page): Promise<void> {
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-line]")]
    const code = (row: Element): Element => row.querySelector("code") ?? row
    const selectableText = (element: Element): Text => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node instanceof Text && node.length >= 3) return node
      }
      throw new Error("selection anchor has no text node with at least three characters")
    }
    const range = document.createRange()
    range.setStart(selectableText(code(rows[4])), 0)
    range.setEnd(selectableText(code(rows[6])), 3)
    const selection = window.getSelection()
    if (!selection) throw new Error("window selection is unavailable")
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event("selectionchange"))
  })
}

function requireX(box: ElementBox | null, label: string): number {
  if (!box) throw new Error(`${label} has no bounding box`)
  return box.x
}
