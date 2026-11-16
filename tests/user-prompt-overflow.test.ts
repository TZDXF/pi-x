import { expect, test } from "vitest"
import { readFileSync } from "node:fs"

/**
 * TZD-119：批注/上下文卡片里的超长文本不得把卡片撑破容器。
 *
 * 事故形态（截图基线）：代码批注 chip 的路径段是 `shrink-0`，超长路径既不会换行、
 * 也不会被压缩，chip 宽度长成 max-content；父级 `overflow-hidden` 再把它裁掉，
 * 于是"文本横向溢出被裁切"。辅助对话面板只有几百像素宽，这个组合必然触发。
 *
 * 这里钉住修复后的两条不变量：
 * 1. chip 的文本段全部可收缩（`min-w-0` + `truncate`）且带 `title` 兜底全文；
 * 2. 气泡内的宽块不用 `vw` 定宽 —— 气泡可能在窄侧栏里，按视口算宽度会顶出容器。
 */
const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8")

test("code comment chips never size to their content", () => {
  const view = source("components/chat/ChatUserPrompt.vue")
  const composer = source("components/chat/ChatComposer.vue")
  for (const [file, name] of [
    [view, "ChatUserPrompt"],
    [composer, "ChatComposer"],
  ] as const) {
    // 反向护栏：路径段曾写作 `shrink-0 font-mono`，长路径会顶破卡片。
    expect(file, name).not.toMatch(/shrink-0 font-mono/)
    // 路径与批注两段都必须可收缩，并各自截断。两段共用 `basis-0 + grow`：
    // 只给一段 `flex-1`、另一段 `basis-auto` 时，后者会按 max-content 吃满宽度。
    expect(file, name).toMatch(/min-w-0 basis-0 grow-\[3\] truncate font-mono/)
    expect(file, name).toMatch(/line-clamp-2 min-w-0 basis-0 grow-\[2\]/)
    // 截断必须可回溯：路径段的 title 给出完整路径（批注段原本就有 title）。
    expect(file, name).toMatch(/:title="c\.path"/)
  }
})

test("selection chips keep their comment shrinkable inside the bubble", () => {
  const view = source("components/chat/ChatUserPrompt.vue")
  // 两段文本都在 chip 内：选中文本 + 批注，后者曾被固定宽度顶出气泡。
  expect(view).toMatch(/class="line-clamp-2 min-w-0 basis-0 grow-\[3\]/)
  expect(view).toMatch(/line-clamp-2 min-w-0 basis-0 grow-\[2\]/)
  // 行容器与正文容器都要能收缩（`min-w-0`），否则 chip 的 max-content 宽度仍会顶出去。
  expect(view).toMatch(/class="mt-1\.5 flex min-w-0 flex-wrap gap-1\.5"/)
  expect(view).toMatch(/<div class="min-w-0 text-sm">/)
})

test("bubble blocks never size themselves from the viewport", () => {
  const view = source("components/chat/ChatUserPrompt.vue")
  // 辅助对话面板是几百像素宽的侧栏 Tab：`w-[min(36rem,75vw)]` 曾在 1280px 视口下
  // 算成 576px，直接顶出面板（实测 TZD-119）。
  expect(view).not.toMatch(/75vw/)
  // 编辑框宽度跟气泡走，旧宽度被 max-w 封顶。
  expect(view).toMatch(/class="w-full max-w-\[36rem\] min-w-0 space-y-2"/)
})

test("the aux parent-context block is kept in data only (no bubble UI)", () => {
  const view = source("components/chat/ChatUserPrompt.vue")
  // 块仍然在 prompt / 历史 entry 里（送模型、编辑重发都用），但气泡不再渲染它。
  expect(view).not.toMatch(/data-aux-parent-context/)
  expect(view).not.toMatch(/chat\.parentContext/)
  // 展示与复制仍走解析后的可见正文。
  expect(view).toMatch(/const parsedPrompt = computed\(\(\) => parseComposerPromptContexts/)
})
