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
    // 路径段不再 `shrink-0`（长路径会顶破卡片），而是可收缩 + 截断。
    expect(file, name).not.toMatch(/min-w-0 basis-0 grow-\[3\] truncate font-mono shrink-0/)
    expect(file, name).toMatch(/min-w-0 basis-0 grow-\[3\] truncate font-mono/)
    expect(file, name).toMatch(/line-clamp-2 min-w-0 basis-0 grow-\[2\]/)
    // 行号是**独立后缀段**：`shrink-0` 且不参与路径的 truncate（否则窄面板下行号被省略）。
    expect(file, name).toMatch(/shrink-0 font-mono" data-code-comment-lines/)
    // 行号不再拼进路径的截断 span 里（旧写法 `{{ c.path }}:{{ c.startLine }}`）。
    expect(file, name).not.toMatch(/c\.path }}:{{ c\.startLine/)
    // 截断必须可回溯：路径段 title 给完整 `path:行号`（气泡与 composer 都用 commentPathLabel），
    // 行号独立可读，批注段有 title。
    expect(file, name).toMatch(/:title="commentPathLabel\(c\)"/)
    expect(file, name).toMatch(/:title="c\.comment"/)
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

test("line labels share one format with the prompt block", async () => {
  // chip 的行号段与 prompt 里的 `Lines:` 必须同源，避免两处格式漂移（`10` vs `10-10`）。
  const { commentLineLabel, commentPathLabel, formatCodeComment } = await import("@/lib/codeComments")
  expect(commentLineLabel(10, 10)).toBe("10")
  expect(commentLineLabel(2, 5)).toBe("2-5")
  expect(commentPathLabel({ path: "src/a.ts", startLine: 2, endLine: 5 })).toBe("src/a.ts:2-5")
  expect(
    formatCodeComment({ path: "src/a.ts", startLine: 2, endLine: 5, selectedText: "", comment: "x" }, 0),
  ).toContain("Lines: 2-5")
})

test("the aux parent-context block is kept in data only (no bubble UI)", () => {
  const view = source("components/chat/ChatUserPrompt.vue")
  // 块仍然在 prompt / 历史 entry 里（送模型、编辑重发都用），但气泡不再渲染它。
  expect(view).not.toMatch(/data-aux-parent-context/)
  expect(view).not.toMatch(/chat\.parentContext/)
  // 展示与复制仍走解析后的可见正文。
  expect(view).toMatch(/const parsedPrompt = computed\(\(\) => parseComposerPromptContexts/)
})
