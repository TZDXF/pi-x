/**
 * 提问气泡的折叠阈值（TZD-138）：可见正文超过 6 个**视觉行**时折叠，点击/按钮展开全文。
 *
 * 折叠只影响**只读展示**：气泡正文按 6 个视觉行的高度裁剪，`entry.text` / `contextText`、
 * 复制文本、编辑框与重发用的 prompt 全部保持原文 —— 折叠不改变消息内容，只改变当前可见
 * 的行数。输入编辑态（`Textarea`）不受这里任何约束。
 *
 * 判据是**实际视觉行边界**，不是 `\n` 计数，也不是"内容全高 vs 6 × 计算行高"：中文自动
 * 折行会多占行；同一行里放文件引用 chip（`inline-flex` + border/padding）时该行的行盒
 * 比正文行高更高（实测行距 21~22px vs `line-height: 20px`）。按"6 × line-height"裁剪会
 * 把第 6 行切掉下半截并错误地给出折叠按钮（QA 实测 TZD-138 P2）。因此这里把
 * `Range.getClientRects()` 的矩形按竖直方向分组成视觉行，行盒取该行所有矩形的并集，
 * 裁剪高度取第 6 行的**下边界**，并以第 7 行的上边界封顶（不露出第 7 行的半截）。
 *
 * `Range.getClientRects()` 不受祖先 `overflow: hidden` 裁剪影响（实测裁剪态下仍返回全部
 * 行的矩形），所以"测量"与"裁剪"可以共存。
 */

/** 折叠阈值：超过该视觉行数即折叠（用户要求 6 行）。 */
export const PROMPT_COLLAPSE_LINES = 6

/** 一个矩形／行盒（竖直方向的两个边界）；坐标必须统一（推荐相对正文内容顶端）。 */
export interface PromptLineBox {
  top: number
  bottom: number
}

/** 折叠测量结果：视觉行数与裁剪高度（`clampHeight: 0` 表示不需要裁剪）。 */
export interface PromptClampMeasure {
  /** 正文共占多少个视觉行。 */
  lineCount: number
  /** 折叠态保留的高度（px，相对正文内容顶端）；不裁剪时为 0。 */
  clampHeight: number
}

/** 重叠比例阈值：同一视觉行内的矩形互相压住大半，相邻行的矩形只擦边（或干脆不接）。 */
const SAME_LINE_OVERLAP_RATIO = 0.5

/**
 * 把 `Range.getClientRects()` 的矩形按视觉行分组。
 *
 * 同一行的多个矩形（文字段与 chip）**大半互相重合**（chip 更高，会超出正文行高），取并集
 * 作为行盒 —— 这正是"按实际视觉行边界"的关键。判据是重叠比例而不是"有没有碰到一起"：
 * 行距可能只比行盒小 1px（QA 的 chip 行是 22px 行盒 / 21px 行距），任何重叠都算同一行会
 * 把相邻两行并成一行、漏掉真正的溢出。高度为 0 的退化矩形（换行符、段落末尾）不计入。
 */
export function groupPromptLines(rects: readonly PromptLineBox[], ratio = SAME_LINE_OVERLAP_RATIO): PromptLineBox[] {
  const lines: PromptLineBox[] = []
  const sorted = [...rects]
    .filter(rect => rect.bottom - rect.top > 0)
    .sort((a, b) => a.top - b.top || a.bottom - b.bottom)
  for (const rect of sorted) {
    const line = lines[lines.length - 1]
    const overlap = line ? Math.min(line.bottom, rect.bottom) - Math.max(line.top, rect.top) : 0
    const shorter = line ? Math.min(line.bottom - line.top, rect.bottom - rect.top) : 0
    // 与上一行大半重合 → 同一视觉行（chip 的行盒更高，行盒取并集）。
    if (line && overlap > shorter * ratio) {
      line.top = Math.min(line.top, rect.top)
      line.bottom = Math.max(line.bottom, rect.bottom)
      continue
    }
    lines.push({ top: rect.top, bottom: rect.bottom })
  }
  return lines
}

/**
 * 用视觉行盒算折叠裁剪高度（`rects` 的坐标应相对正文内容顶端，即 `max-height` 的起点）。
 *
 * - 行数不超过阈值：不裁剪。恰好 6 行（哪怕每行都带 chip、行盒更高）也完整显示，
 *   且没有折叠按钮；
 * - 超过阈值：裁剪到第 `limit` 行的**下边界**，且不超过第 `limit + 1` 行的上边界 ——
 *   既不会把第 6 行（含 chip）切掉下半截，也不会露出第 7 行。
 *
 * 量不到矩形时（未挂载、`display: none`、字体尚未加载导致 0 尺寸）返回 `lineCount: 0`，
 * 调用方据此保持"不折叠"，不给凭空的折叠按钮或裁剪。
 */
export function measurePromptClamp(
  rects: readonly PromptLineBox[],
  limit: number = PROMPT_COLLAPSE_LINES,
): PromptClampMeasure {
  const lines = groupPromptLines(rects)
  if (lines.length <= limit) return { lineCount: lines.length, clampHeight: 0 }
  const limitLine = lines[limit - 1]!
  const nextLine = lines[limit]!
  // 第 limit 行的墨迹下边界（含更高行盒的 chip），以第 limit+1 行的上边界封顶。
  return { lineCount: lines.length, clampHeight: Math.max(0, Math.min(limitLine.bottom, nextLine.top)) }
}
