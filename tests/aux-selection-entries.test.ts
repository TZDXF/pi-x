import { expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { compileScript, parse } from "vue/compiler-sfc"

/**
 * 第二入口（代码 / Markdown 预览）的接线（TZD-103）：复用**同一份**浮层、
 * 只加动作、不新建定位逻辑；payload 带 `path` + 行区间；aux 归属按会话 runtimeId。
 *
 * 这里只钉"接线与复用"，浮层本身的行为由 `aux-selection-menu.test.ts` 真执行覆盖。
 * 断言用 `toContain` 的普通字符串（避免长正则里的转义把意图弄得难读）。
 */
const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8")

test("the file preview mounts the same floating menu in code mode with path and runtime", () => {
  const preview = read("components/ProjectFilePreview.vue")
  // 复用同一个组件（不新建定位逻辑）。
  expect(preview).toContain('from "@/components/chat/ConversationSelectionMenu.vue"')
  expect(preview).toContain("<ConversationSelectionMenu")
  expect(preview).toContain('mode="code"')
  expect(preview).toContain(':path="path"')
  expect(preview).toContain('@aux-ask="onAuxAsk"')
  // 代码视图与渲染态 Markdown 都要能被同一浮层检测到（渲染态没有 [data-line]，只带 path）。
  expect(preview).toContain("const menuRoot = computed<HTMLElement | null>(() => (showCode.value")
  expect(preview).toContain('ref="markdownRoot"')
  // 上限定长与会话正文一致（复用同一个常量，不新引入魔数）。
  expect(preview).toContain("CONVERSATION_SELECTION_MAX_TEXT_LENGTH")
})

test("the preview delivers through the shared aux route, defaulting to the active session", () => {
  const preview = read("components/ProjectFilePreview.vue")
  expect(preview).toContain('import { askAuxSelection } from "@/lib/auxAsk"')
  expect(preview).toContain("const parentRuntimeId = props.auxParentRuntimeId ?? activeRuntimeId.value")
  expect(preview).toContain("await askAuxSelection({")
  // 失败提示走 ui store 的 toast（不静默）。
  expect(preview).toContain("toast: (message, kind) => ui.pushToast(message, kind)")
})

test("the files panel and sidebar pass the owning session runtime down", () => {
  const files = read("components/ProjectFiles.vue")
  expect(files).toContain("auxParentRuntimeId?: string | null")
  expect(files).toContain(':aux-parent-runtime-id="auxParentRuntimeId"')
  const sidebar = read("components/RightSidebar.vue")
  // 侧栏的父上下文就是该 aux 实例的父会话（`auxParent.runtimeId`）。
  expect(sidebar).toContain(':aux-parent-runtime-id="auxParent?.runtimeId"')
})

test("the chat list forwards auxAsk and routes quotes into the aux pane's own bucket", () => {
  const list = read("components/chat/ChatTurnList.vue")
  expect(list).toContain("auxRuntimeId?: string")
  expect(list).toContain("@aux-ask=\"(payload, target) => emit('auxAsk', payload, target)\"")
  expect(list).toContain(':aux-targets="auxTargets"')
  expect(list).toContain(':aux-can-create="auxCanCreate"')
  expect(list).toContain("auxRuntimeId: props.auxRuntimeId")
  const pane = read("components/aux-chat/AuxChatPane.vue")
  expect(pane).toContain(':aux-runtime-id="runtimeId"')
  expect(pane).toContain('@aux-ask="onAuxAsk"')
  // 面板内的划词直接进本实例的桶（同一个 Tab 内只有一处摘要）。
  expect(pane).toContain("addAuxSelection(props.tab.runtimeId, { ...payload, sourceRuntimeId: props.tab.runtimeId })")
})

test("ChatView routes the chat selection gesture without growing the view", () => {
  const chat = read("components/ChatView.vue")
  expect(chat).toContain('@aux-ask="sidebar.askAux"')
  // 规模护栏不变（逻辑仍全在 composable 里）。
  expect(chat.split("\n").length).toBeLessThan(500)
  const sidebar = read("composables/useChatViewSidebar.ts")
  expect(sidebar).toContain("async function askAux(payload: AuxAskPayload, target?: AuxAskTarget)")
  expect(sidebar).toContain("const auxTargets = computed(() => auxInstancesFor(deps.runtimeId))")
  expect(sidebar).toContain("parentRuntimeId: deps.runtimeId")
  // 复用与新建都要让面板可见。
  expect(sidebar).toContain("if (outcome.ok) deps.onFirstTabAdded()")
})

test("the aux pane send control reads its own bucket instead of full isolation", () => {
  const pane = read("components/aux-chat/AuxChatPane.vue")
  // TZD-103 把 `contexts: "none"` 升级成 `"aux"`：读本桶、只清本桶，批注仍不消费。
  expect(pane).toContain('contexts: "aux"')
  const control = read("composables/useChatSendControl.ts")
  expect(control).toContain('contexts?: "shared" | "aux" | "none"')
  expect(control).toContain("if (auxScoped) return [...auxSelectionItems(session.runtimeId)]")
  expect(control).toContain("if (auxScoped) clearAuxSelectionBucket(session.runtimeId)")
})

test("the preview keeps caller attrs on its single visible root (fragment regression)", () => {
  // 回归（TZD-103 阻塞项）：模板有两个根（section + 覆盖层浮层）时，Vue 3 不再自动继承
  // attrs —— `data-package-resource-preview`（E2E 定位）与 `class` 会静默丢失。
  // 修法：显式 `inheritAttrs: false` + 只把 attrs 绑到 section 上。
  const preview = read("components/ProjectFilePreview.vue")
  expect(preview).toContain("defineOptions({ inheritAttrs: false })")
  // section 起始标签带 `v-bind="$attrs"`（从模板起点找，避免命中脚本里的注释）。
  const templateStart = preview.indexOf("</script>")
  const sectionStart = preview.indexOf("<section", templateStart)
  const sectionTag = preview.slice(sectionStart, preview.indexOf(">", sectionStart) + 1)
  expect(sectionTag).toContain('v-bind="$attrs"')
  // 浮层是覆盖层，不该接调用方属性（否则 data-* 会落到浮层上）。
  const menu = preview.slice(preview.indexOf("<ConversationSelectionMenu"))
  expect(menu).not.toContain('v-bind="$attrs"')
  // 结构证据：section 仍是可见根，浮层挂在其后（不是 section 内部子节点）。
  const section = preview.indexOf("<section", preview.indexOf("</script>"))
  const sectionEnd = preview.indexOf("</section>")
  const menuAt = preview.indexOf("<ConversationSelectionMenu")
  expect(section).toBeGreaterThan(-1)
  expect(menuAt).toBeGreaterThan(sectionEnd)
})

test("the aux composer forwards summary locate/edit to the exposed chat list", () => {
  const pane = read("components/aux-chat/AuxChatPane.vue")
  // P2-3：子组件 emit 了，但没接线就等于点了没反应。
  expect(pane).toContain('@locate-selection="conversation?.locateSelection($event)"')
  expect(pane).toContain('@edit-selection="conversation?.editSelection($event)"')
  // 编译真实模板：两个处理器在 `ChatComposer` 上必须真的存在（不能是 undefined）。
  const { descriptor } = parse(pane)
  const compiled = compileScript(descriptor, { id: "aux-pane-wiring", inlineTemplate: true }).content
  expect(compiled).toContain("onLocateSelection")
  expect(compiled).toContain("onEditSelection")
  expect(compiled).toMatch(/locateSelection/)
  expect(compiled).toMatch(/editSelection/)
})

test("i18n carries the two new keys in both locales", () => {
  for (const locale of ["zh-CN", "en"]) {
    const messages = read(`i18n/locales/${locale}.ts`)
    expect(messages).toContain("selectionAskAux: ")
    expect(messages).toContain("askFailed: ")
    expect(messages).toContain("chooseTarget: ")
    expect(messages).toContain("newChat: ")
  }
})
