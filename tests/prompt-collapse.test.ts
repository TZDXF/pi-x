import { test, expect } from "vitest"
import { PROMPT_COLLAPSE_LINES, groupPromptLines, measurePromptClamp, type PromptLineBox } from "@/lib/promptCollapse"
import { chatSource } from "./fixtures/chatSources"

/**
 * TZD-138：提问正文超过 6 行折叠，点击展开全文。
 *
 * 这里钉住四件事：
 * 1. 判定（`lib/promptCollapse.ts`）按**实际视觉行边界**：`Range.getClientRects()` 的矩形
 *    竖直分组成行，行盒取并集 —— 含 chip 的行更高，按 `6 × line-height` 判定会把恰好
 *    6 行的正文误判成溢出（QA 的 P2）；
 * 2. 折叠只是**展示裁剪**：`ChatUserPrompt` 的正文容器裁高度，`entry.text` 原样交给
 *    解析器/复制/编辑，组件不持有"截断后的文本"；
 * 3. 编辑态（`Textarea`）与折叠分支互斥 —— 编辑框永远拿全文；
 * 4. 裁剪区里的划词引用：折叠态不画徽标，定位/编辑前先展开正文再重算锚点。
 *
 * 真实布局（折叠后到底剩 6 个视觉行、点击是否真的展开）由
 * `e2e/prompt-collapse.spec.ts` 量。
 */

/** 构造一屏矩形：`lines` 行，每行给了高度；`pinch` 模拟行内 chip 把行盒撑高。 */
function rects(lines: number, { gap = 20, lineHeight = 19, chipExtra = 0 } = {}): PromptLineBox[] {
  const out: PromptLineBox[] = []
  for (let i = 0; i < lines; i++) {
    const top = i * gap
    // 文字段：贴着行 1px 内边
    out.push({ top: top + 0.5, bottom: top + 0.5 + lineHeight })
    // 退化矩形（换行符 / 段落末尾）：高度 0，必须被忽略
    out.push({ top: top + 0.5, bottom: top + 0.5 })
    // chip：比正文行高更高（QA 截图：22px vs line-height 20px）
    if (chipExtra > 0) out.push({ top: top - chipExtra / 2, bottom: top + lineHeight + chipExtra / 2 })
  }
  return out
}

test("collapse threshold is six visual lines", () => {
  expect(PROMPT_COLLAPSE_LINES).toBe(6)
})

test("exactly six visual lines never collapse, even when every line carries a chip", () => {
  const plain = measurePromptClamp(rects(6))
  expect(plain.lineCount).toBe(6)
  expect(plain.clampHeight, "six plain lines are fully visible").toBe(0)

  // 每行一个 chip，行盒 22px、行距 22px：旧的"6 × lineHeight(20)"判定会裁 120px，
  // 把第 6 行切掉下半截。按实际视觉行边界必须是 6 行、不裁剪。
  const withChips = measurePromptClamp(rects(6, { gap: 22, chipExtra: 3 }))
  expect(withChips.lineCount).toBe(6)
  expect(withChips.clampHeight).toBe(0)
})

test("adjacent chip lines that barely overlap are still counted separately", () => {
  // 相邻两行的行盒只擦到 1px（22px 行盒 / 21px 行距）：如果"任何重叠算同一行"，
  // 12 行会被并成 6 行、6 行的场景会被并成 3 行 —— 折叠判定与裁剪高度都会错。
  const tight: PromptLineBox[] = []
  for (let i = 0; i < 12; i++) {
    const top = i * 21
    tight.push({ top: top + 1, bottom: top + 20 })
    tight.push({ top, bottom: top + 22 })
  }
  expect(groupPromptLines(tight)).toHaveLength(12)
  // 恰好 6 行这种形态：不折叠。
  const six = groupPromptLines(tight.slice(0, 12))
  expect(six).toHaveLength(6)
  expect(measurePromptClamp(tight.slice(0, 12))).toEqual({ lineCount: 6, clampHeight: 0 })
})

test("seven visual lines collapse exactly below the seventh line", () => {
  // 7 行、每行带 chip（行距 22px）：裁剪高度收在第 6 行下边界处、第 7 行上边界之上。
  const seven = measurePromptClamp(rects(7, { gap: 22, chipExtra: 3 }))
  expect(seven.lineCount).toBe(7)
  // 第 6 行（index 5）的 chip 行盒下边界 = 5 * 22 + 19 + 1.5 = 130.5，恰好是第 7 行的上边界
  // （6 * 22 - 1.5 = 130.5）：第 6 行完整可见，第 7 行一点都不露。
  expect(seven.clampHeight).toBe(6 * 22 - 1.5)
})

test("plain fourteen lines clamp to six line heights", () => {
  const many = measurePromptClamp(rects(14))
  expect(many.lineCount).toBe(14)
  // 每行 20px、文字段高 19px（0.5 内边）：第 6 行下边界 = 100 + 19.5 = 119.5。
  expect(many.clampHeight).toBeGreaterThanOrEqual(119)
  expect(many.clampHeight).toBeLessThanOrEqual(120)
})

test("degenerate and overlapping rects never inflate the line count", () => {
  const degens = groupPromptLines([
    { top: 0, bottom: 0 },
    { top: 0, bottom: 0 },
    { top: 0.5, bottom: 19.5 },
    { top: -1.5, bottom: 20.5 }, // 同一行的 chip
    { top: 20, bottom: 40 },
  ])
  expect(degens).toEqual([
    { top: -1.5, bottom: 20.5 },
    { top: 20, bottom: 40 },
  ])
})

test("unmeasurable layout never collapses", () => {
  expect(measurePromptClamp([])).toEqual({ lineCount: 0, clampHeight: 0 })
  expect(measurePromptClamp([{ top: 0, bottom: 0 }])).toEqual({ lineCount: 0, clampHeight: 0 })
})

test("the clamp height never reaches the next line", () => {
  // 行高解析不出来时（lineHeight = 0）也必须收在第 6 行底边，而不是 6 × 0 或溢出到第 7 行。
  const noLineHeight = measurePromptClamp(rects(9, { gap: 22, chipExtra: 3 }))
  expect(noLineHeight.clampHeight).toBeLessThanOrEqual(6 * 22 - 1.5)
  expect(noLineHeight.clampHeight).toBeGreaterThan(5 * 22)
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
  expect(body).toMatch(/maxHeight: `\$\{clampHeight\.value\}px`/)
  expect(body).toMatch(/overflow-hidden/)
  // 行数与裁剪高度来自视觉行测量（`getClientRects` 分组），不是 `\n` 计数或 6 × 行高。
  expect(body).toMatch(/range\.getClientRects\(\)/)
  expect(body).toMatch(/measurePromptClamp\(/)
  expect(body).not.toMatch(/slice\(|substring\(/)
  expect(body).not.toMatch(/maxHeight: `\$\{lineHeight\.value \* PROMPT_COLLAPSE_LINES\}`/)
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

test("clipped references are hidden while collapsed and revealed before locating", () => {
  const quotes = chatSource("composables/useSelectionQuotes.ts")
  const list = chatSource("components/chat/ChatTurnList.vue")
  // 折叠容器有稳定标记，定位逻辑据此判断"这段正文被裁着"。
  const body = chatSource("components/chat/CollapsiblePromptText.vue")
  expect(body).toMatch(/data-prompt-text/)
  expect(body).toMatch(/:data-prompt-collapsed="collapsed && overflowing \? 'true' : 'false'"/)
  // 裁剪区里的徽标不画（否则徽标落在气泡下方空白处）。
  expect(quotes).toMatch(/if \(isClippedOut\(wrapper, rect\)\) return/)
  // 定位/编辑前先展开正文，再重算锚点（否则只滚到看不见的徽标）。
  // 定位链路每次重新查目标正文；卸载/重挂后也要再查一次（`scrollToMessage` 之后）。
  expect(quotes).toMatch(/return revealClippedSelection\(wrapper, targetEndOffset, targetMessageId\)/)
  expect(quotes.indexOf("await conversation.value?.scrollToMessage")).toBeGreaterThan(-1)
  // 重挂之后（`scrollToMessage` 之后）还有一次 `revealTargetIfClipped()`。
  expect(quotes.lastIndexOf("await revealTargetIfClipped()")).toBeGreaterThan(
    quotes.indexOf("await conversation.value?.scrollToMessage"),
  )
  // 重算后仍有徽标滚动的收尾步骤，保证首次点击即可定位。
  expect(quotes.indexOf("await recomputeAnchors()")).toBeGreaterThan(-1)
  expect(quotes).toMatch(/await recomputeAnchors\(\)\n\s*\}/)
  // 展开入口由列表层提供，并按 entry id 幂等。
  expect(quotes).toMatch(/revealClippedPrompt\?: \(messageId: number\) => boolean/)
  expect(list).toMatch(/revealClippedPrompt,\n\}/)
  expect(list).toMatch(/function revealClippedPrompt\(entryId: number\)[\s\S]*expandedPrompts\.add\(entryId\)/)
})
