import { expect, test } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h, ref, computed } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import KanbanBoard from '/src/components/kanban/KanbanBoard.vue'
import { useWorkspaceStore } from '/src/stores/workspace'
import zhCN from '/src/i18n/locales/zh-CN'
import '/src/style.css'
const pinia = createPinia(), ws = useWorkspaceStore(pinia), opened = ref(false)
ws.boardDrafts = { todo: {id:'todo',project:'/project',message:'原始待办',createdAt:1,updatedAt:1} }
ws.histories = {'/project': [
  {file:'/idle.jsonl',cwd:'/project',title:'闲置会话'},
  {file:'/completed.jsonl',cwd:'/project',title:'完成会话'},
]}
ws.upsertBoardDraft = draft => { ws.boardDrafts[draft.id] = draft }
ws.flushPersistence = async () => {}
ws.update = async (row,title,archived) => { row.archived = archived }
ws.refresh = async () => {}
const cards = computed(() => [
  ...Object.values(ws.boardDrafts).map(d => ({id:d.id,draftId:d.id,project:d.project,projectName:'Project',title:d.message,preview:d.message,status:'todo',updatedAt:d.updatedAt})),
  ...ws.histories['/project'].filter(s => !s.archived).map(s => ({id:s.file,file:s.file,cwd:s.cwd,project:s.cwd,projectName:'Project',title:s.title,preview:'会话内容',status:s.file.includes('idle')?'idle':'completed',updatedAt:1})),
])
createApp({render: () => h('div', {style:'height:640px'}, [
  h(KanbanBoard, {cards:cards.value,projects:[{value:'/project',label:'Project'}],selectedProject:'',onOpen:()=>{opened.value=true}}),
  h('output', {'data-details-open':String(opened.value)}),
])}).use(pinia).use(createI18n({legacy:false,locale:'zh-CN',messages:{'zh-CN':zhCN}})).mount('#app')
</script></body></html>`

let harness: VueHarness
test.beforeAll(async () => {
  harness = await startVueHarness({ name: "kanban-card-actions", port: 1543, html })
})
test.afterAll(async () => harness?.close())
test.use({ viewport: { width: 1500, height: 720 } })

test("todo clicks stay on the board and hover editing saves in a dialog", async ({ page }) => {
  await page.goto(harness.url)
  const card = page.locator('[data-kanban-card="todo"]')
  const edit = page.getByRole("button", { name: "编辑待办", exact: true })
  await expect(edit).toHaveCSS("opacity", "0")
  await card.click()
  await expect(page.locator("output")).toHaveAttribute("data-details-open", "false")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await card.hover()
  await expect(edit).toHaveCSS("opacity", "1")
  await page.screenshot({ path: "temp/kanban-card-actions.png" })
  await edit.click()
  const dialog = page.getByRole("dialog", { name: "编辑待办" })
  await expect(dialog).toBeVisible()
  await dialog.getByRole("textbox").fill("修改后的待办")
  await dialog.getByRole("button", { name: "保存待办", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(card).toContainText("修改后的待办")
  await expect(page.locator("output")).toHaveAttribute("data-details-open", "false")
})

test("idle and completed cards show archive icons that do not open the conversation", async ({ page }) => {
  await page.goto(harness.url)
  for (const status of ["idle", "completed"]) {
    const column = page.locator('[data-kanban-column="' + status + '"]')
    const archive = column.getByRole("button", { name: "归档会话", exact: true })
    await expect(archive).toBeVisible()
    await archive.click()
    await expect(column.locator("[data-kanban-card]")).toHaveCount(0)
    await expect(page.locator("output")).toHaveAttribute("data-details-open", "false")
  }
})
