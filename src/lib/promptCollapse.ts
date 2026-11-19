/**
 * 提问气泡的折叠阈值（TZD-138）：可见正文超过 6 个**视觉行**时折叠，点击/按钮展开全文。
 *
 * 折叠只影响**只读展示**：气泡正文按 6 行高度裁剪，`entry.text` / `contextText`、
 * 复制文本、编辑框与重发用的 prompt 全部保持原文 —— 折叠不改变消息内容，只改变
 * 当前可见的行数。输入编辑态（`Textarea`）不受这里任何约束。
 *
 * 判据用"内容全高 vs 6 行高度"，而不是文本里的 `\n` 计数：中文会自动折行、窄面板下
 * 同一段文字占更多视觉行，只有布局能量出真实行数。`scrollHeight` 在 `max-height` +
 * `overflow: hidden` 下仍是**内容全高**，所以裁剪与测量可以共存（Chromium 实测
 * 168 vs 126）。
 */

/** 折叠阈值：超过该视觉行数即折叠（用户要求 6 行）。 */
export const PROMPT_COLLAPSE_LINES = 6

/**
 * 折叠态的高度上限（CSS）。用 `lh` 单位而不是 JS 算出的像素：首帧就能裁好，
 * 不会先糊一屏再收起；行高变化（字号/主题）时 CSS 自己跟上。
 */
export function promptClampMaxHeight(limit: number = PROMPT_COLLAPSE_LINES): string {
  return `calc(${limit} * 1lh)`
}

/** 折叠态保留的高度（px），供测量与测试对照：恰好 `limit` 行，不把第 7 行裁成半行。 */
export function promptClampHeight(lineHeight: number, limit: number = PROMPT_COLLAPSE_LINES): number {
  if (!(lineHeight > 0)) return 0
  return lineHeight * Math.max(1, limit)
}

/**
 * 是否需要折叠。亚像素误差（行高的分数部分）不算溢出，否则 6 行整会被误判成 7 行。
 * 量不到行高时（`lineHeight: normal`、未挂载、字体尚未加载）返回 `false`：
 * 宁可先不折叠，也不要凭空的折叠按钮。
 */
export function shouldCollapsePrompt(
  contentHeight: number,
  lineHeight: number,
  limit: number = PROMPT_COLLAPSE_LINES,
): boolean {
  const clamp = promptClampHeight(lineHeight, limit)
  if (!clamp) return false
  if (!(contentHeight > 0)) return false
  return contentHeight - clamp > 0.5
}
