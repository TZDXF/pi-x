import { test, expect } from "vitest"
import {
  PROMPT_COLLAPSE_LINES,
  promptClampHeight,
  promptClampMaxHeight,
  shouldCollapsePrompt,
} from "@/lib/promptCollapse"
import { chatSource } from "./fixtures/chatSources"

/**
 * TZD-138：提问正文超过 6 行折叠，点击展开全文。
 *
 * 这里钉住三件事：
 * 1. 阈值判定（`lib/promptCollapse.ts`）—— 视觉行数而不是 `\n` 计数，且亚像素不误判；
 * 2. 折叠只是**展示裁剪**：`ChatUserPrompt` 的正文容器裁高度，`entry.text` 原样交给
 *    解析器/复制/编辑，组件不持有"截断后的文本"；
 * 3. 编辑态（`Textarea`）与折叠分支互斥 —— 编辑框永远拿全文，不受折叠影响。
 *
 * 真实布局（折叠后到底剩 6 行、点击是否真的展开）由 `e2e/prompt-collapse.spec.ts` 量。
 */

test("collapse clamps at six visual lines", () => {
  expect(PROMPT_COLLAPSE_LINES).toBe(6)
  expect(promptClampMaxHeight()).toBe("calc(6 * 1lh)")
})

test("overflow means more than the clamp height, ignoring sub-pixel rounding", () => {
  const lineHeight = 20
  const clamp = promptClampHeight(lineHeight)
  expect(clamp).toBe(120)
  // 恰好 6 行：不折叠。
  expect(shouldCollapsePrompt(clamp, lineHeight)).toBe(false)
  // 6 行整 + 半像素（行高的小数部分）：仍不折叠。
  expect(shouldCollapsePrompt(clamp + 0.5, lineHeight)).toBe(false)
  // 第 7 行哪怕只露出一点点：折叠。
  expect(shouldCollapsePrompt(clamp + 1, lineHeight)).toBe(true)
  expect(shouldCollapsePrompt(clamp * 3, lineHeight)).toBe(true)
})

test("unmeasurable layout never collapses", () => {
  // `lineHeight: normal` / 未挂载 / 字体未就绪：量不到行高时不做判断。
  expect(shouldCollapsePrompt(400, 0)).toBe(false)
  expect(promptClampHeight(0)).toBe(0)
  expect(shouldCollapsePrompt(0, 20)).toBe(false)
})

test("the prompt bubble keeps the original text and only clamps height", () => {
  const view = chatSource("components/chat/ChatUserPrompt.vue")
  const body = chatSource("components/chat/CollapsiblePromptText.vue")
  // 正文仍由解析后的完整可见正文驱动；折叠组件只拿 text + expanded，不做截断。
  expect(view).toMatch(/<CollapsiblePromptText[\s\S]*?text="parsedPrompt\.visibleContent"/)
  expect(view).toMatch(/:expanded="!!promptExpanded"/)
  // 复制与编辑走原始正文（折叠不改变内容）。
  expect(view).toMatch(
    /const visibleText = computed\(\(\) => parseComposerPromptContexts\(props\.entry\.text\)\.visibleContent\)/,
  )
  expect(view).toMatch(/@click="emit\('copyText', visibleText\)"/)
  // 裁剪只发生在正文容器上：`max-height` + `overflow: hidden`，不截字符串。
  expect(body).toMatch(/maxHeight: px > 0 \? `\$\{px\}px` : promptClampMaxHeight\(PROMPT_COLLAPSE_LINES\)/)
  expect(body).toMatch(/overflow-hidden/)
  expect(body).not.toMatch(/slice\(|substring\(|truncate/)
})

test("editing state and the collapsed read-only body are mutually exclusive", () => {
  const view = chatSource("components/chat/ChatUserPrompt.vue")
  // 编辑分支（Textarea，`v-model="editedText"`）与只读分支（折叠正文）是 v-if / v-else。
  expect(view).toMatch(/v-if="editedPrompt\?\.id === entry\.id"[\s\S]*<Textarea[\s\S]*v-model="editedText"/)
  expect(view).toMatch(/<CollapsiblePromptText\s+v-else/)
  expect(view.indexOf('v-if="editedPrompt?.id === entry.id"')).toBeLessThan(view.indexOf("<CollapsiblePromptText"))
  // 编辑框不做任何高度裁剪（`min-h-32 max-h-80` 是用户可拖拽的编辑区，不是折叠）。
  expect(view).toMatch(/class="min-h-32 max-h-80 resize-y"/)
})

test("expanded state is remembered per entry outside virtualized rows", () => {
  const list = chatSource("components/chat/ChatTurnList.vue")
  // 折叠态挂在列表（按 entry id），虚拟行卸载/重建后仍记得用户展开过。
  expect(list).toMatch(/const expandedPrompts = reactive\(new Set<number>\(\)\)/)
  expect(list).toMatch(/:prompt-expanded="expandedPrompts\.has\(entry\.id\)"/)
  expect(list).toMatch(/@toggle-prompt="togglePrompt\(entry\.id\)"/)
  // 切换会话时清空：展开态不能跨会话泄漏到同 id 的消息。
  expect(list).toMatch(/openedProcesses\.clear\(\)\n\s+expandedPrompts\.clear\(\)/)
})
