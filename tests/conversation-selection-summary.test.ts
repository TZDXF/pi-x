import { expect, test, vi } from "vitest"
import { parse } from "vue/compiler-sfc"
import { chatSource } from "./fixtures/chatSources"

const { descriptor } = parse(chatSource("components/chat/ConversationSelectionSummary.vue"))

test("引用列表的滚动容器应用主题细滚动条样式", () => {
  expect(descriptor.template?.content).toMatch(/class="selection-summary-scroll[^"\n]*overflow-auto/)
  const css = descriptor.styles.map(style => style.content).join("\n")
  expect(css).toContain(".selection-summary-scroll {")
  expect(css).toContain("scrollbar-width: thin")
  expect(css).toContain("scrollbar-color: var(--border) transparent")
  expect(css).toContain(".selection-summary-scroll::-webkit-scrollbar-thumb")
})

test("引用列表不再显示回复标签，保留提问标识", () => {
  const template = descriptor.template?.content ?? ""
  expect(template).not.toContain("selectionFromAssistant")
  expect(template).toMatch(/v-if="item.source === 'user'"[^>]*>\s*{{\s*t\("chat.selectionFromUser"\)/)
})


test("删除引用只发送删除事件，不关闭列表", () => {
  const body = descriptor.scriptSetup?.content.match(/function remove\(id: string\) \{([\s\S]*?)\n\}/)?.[1]
  expect(body).toBeDefined()
  const open = { value: true }
  const emit = vi.fn()
  new Function("id", "open", "emit", body!)("selection-1", open, emit)
  expect(emit).toHaveBeenCalledExactlyOnceWith("remove", "selection-1")
  expect(open.value).toBe(true)
})
