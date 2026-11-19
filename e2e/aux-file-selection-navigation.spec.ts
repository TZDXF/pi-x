import { test, expect } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

// 多目录项目组里两个根放置同名文件，覆盖真实项目树 → aux 引用桶 → 实时/历史消息回跳。
const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h, reactive, ref } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import messages from '/src/i18n/locales/en.ts'
import ProjectFiles from '/src/components/ProjectFiles.vue'
import ChatTurnList from '/src/components/chat/ChatTurnList.vue'
import { useWorkspaceStore } from '/src/stores/workspace.ts'
import { activeRuntimeId } from '/src/stores/runtime.ts'
import { auxSessionFor, auxUiFor, registerAuxAskRouter } from '/src/stores/auxChat.ts'
import { auxSelectionItems } from '/src/stores/auxSelections.ts'
import { serializeComposerPromptContexts } from '/src/lib/promptContexts.ts'
import '/src/style.css'
const primary = 'C:/qa-main', extra = 'C:/qa-extra', parentRuntimeId = 'qa-parent', runtimeId = 'qa-aux'
const history = new URLSearchParams(location.search).has('history')
const pinia = createPinia()
createApp({ setup() {
  const workspace = useWorkspaceStore()
  workspace.projectGroups = { [primary]: { name: 'QA', folders: [primary, extra], primary } }
  activeRuntimeId.value = parentRuntimeId
  const session = auxSessionFor(runtimeId), ui = auxUiFor(runtimeId)
  const entries = ref([])
  const edit = reactive({ editedPrompt: null, editedText: '', editBusy: false, editBlocked: true, lastUserPromptId: null })
  const tab = { runtimeId, parentRuntimeId }
  registerAuxAskRouter(parentRuntimeId, {
    active: () => tab,
    open: async () => null,
    reveal() { window.__auxItems = auxSelectionItems(runtimeId) },
  })
  function showPrompt() {
    const text = 'QA prompt'
    const prompt = serializeComposerPromptContexts(text, { selections: auxSelectionItems(runtimeId), comments: [] })
    entries.value = [history ? { kind: 'user', id: 1, text: prompt } : { kind: 'user', id: 1, text, contextText: prompt }]
  }
  return () => h('main', { style: 'display:flex;height:720px;gap:8px' }, [
    h('div', { style: 'display:flex;width:560px' }, [
      h(ProjectFiles, { project: primary, auxParentRuntimeId: parentRuntimeId }),
    ]),
    h('button', { onClick: showPrompt }, 'Fixture send'),
    h('div', { style: 'width:570px;display:flex;flex-direction:column' }, [
      h(ChatTurnList, {
        project: primary, projectName: 'QA', session, ui, renderedEntries: entries.value,
        edit, auxRuntimeId: runtimeId, connecting: false,
      }),
    ]),
  ])
} }).use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } })).use(pinia).mount('#app')
</script></body></html>`

let harness: VueHarness
test.beforeAll(async () => {
  harness = await startVueHarness({ name: "aux-file-selection-navigation", port: 1490, html })
})
test.afterAll(async () => {
  await harness.close()
})
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.set(window, "isTauri", true)
    Reflect.set(window, "__fileReads", [])
    Reflect.set(window, "__TAURI_INTERNALS__", {
      invoke: async (command: string, args: { project: string; path: string }) => {
        if (command === "list_project_directory") return [{ name: "same.ts", path: "same.ts", is_dir: false }]
        if (command !== "read_file_preview") throw Error(`Unexpected command: ${command}`)
        ;(Reflect.get(window, "__fileReads") as unknown[]).push(args)
        const source = args.project === "C:/qa-extra" ? "EXTRA" : "MAIN"
        return { kind: "text", truncated: false, text: `${source}_SOURCE_1\n${source}_SOURCE_2` }
      },
    })
  })
})

for (const history of [false, true]) {
  test(`${history ? "history" : "live"}: selecting again from a reopened secondary-root file preserves its source`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await page.goto(harness.url + (history ? "?history" : ""))
    await page.getByRole("button", { name: "Switch folder" }).click()
    await page.getByRole("menuitem", { name: "qa-extra" }).click()
    await page.getByRole("button", { name: "same.ts" }).click()
    const preview = page.locator('[data-project-files] section[aria-label="File preview"]')
    const selected = preview.getByText("EXTRA_SOURCE_1", { exact: true })
    await expect(selected).toBeVisible()
    await selected.evaluate(element => {
      const range = document.createRange()
      range.selectNodeContents(element)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
    })
    await page.getByRole("button", { name: "Ask in auxiliary chat" }).click()
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "__auxItems")?.map((item: { path: string }) => item.path)))
      .toEqual(["C:/qa-extra/same.ts"])
    await page.getByRole("button", { name: "Fixture send" }).click()
    await page.locator("[data-file-selection-tag]").click()
    const dialog = page.getByRole("dialog")
    await expect(dialog.getByRole("heading", { level: 2 })).toHaveText("C:/qa-extra/same.ts")
    await expect(
      dialog.getByRole("region", { name: "File preview" }).getByText("EXTRA_SOURCE_1", { exact: true }),
    ).toBeVisible()
    expect(await page.evaluate(() => Reflect.get(window, "__fileReads").at(-1))).toMatchObject({
      project: "C:/qa-extra",
      path: "same.ts",
    })

    // 从回跳弹窗内层预览再次划词，仍需保留「会话根 ≠ 文件根」的来源关系。
    const reopened = dialog.getByRole("region", { name: "File preview" }).getByText("EXTRA_SOURCE_1", { exact: true })
    await reopened.evaluate(element => {
      const range = document.createRange()
      range.selectNodeContents(element)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
    })
    await dialog.getByRole("button", { name: "Ask in auxiliary chat" }).click()
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "__auxItems")?.map((item: { path: string }) => item.path)))
      .toEqual(["C:/qa-extra/same.ts"])
    await page.keyboard.press("Escape")
    await page.getByRole("button", { name: "Fixture send" }).click()
    await page.locator("[data-file-selection-tag]").click()
    await expect(
      dialog.getByRole("region", { name: "File preview" }).getByText("EXTRA_SOURCE_1", { exact: true }),
    ).toBeVisible()
    expect(await page.evaluate(() => Reflect.get(window, "__fileReads").at(-1))).toMatchObject({
      project: "C:/qa-extra",
      path: "same.ts",
    })
    if (!history) await page.screenshot({ path: "temp/aux-file-selection-root.png" })
    expect(errors).toEqual([])
  })
}
