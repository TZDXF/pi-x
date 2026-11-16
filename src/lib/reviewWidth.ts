/** 右侧面板的最小宽度（与审查栏一致）。 */
export const REVIEW_MIN_WIDTH = 280
/** 右侧面板拖到最大时仍为会话区保留的最小宽度，避免把会话压到不可用。 */
export const CHAT_MIN_WIDTH = 240

/**
 * 右侧面板可拖拽范围：以可用窗口空间为边界。
 *
 * 面板最大宽度 = 容器宽度减去会话区最小宽度，因此可以覆盖到容器的大部分宽度，
 * 只受窗口空间限制（此前固定的 900px 上限已移除）。窄窗口（overlay 模式）
 * 上面板是覆盖式抽屉，最大即整个容器。
 */
export function reviewWidthBounds(containerWidth: number, overlay: boolean) {
  const available = Math.max(0, containerWidth)
  const max = overlay ? available : Math.max(0, available - CHAT_MIN_WIDTH)
  return { min: Math.min(REVIEW_MIN_WIDTH, max), max }
}

export function clampReviewWidth(width: number, containerWidth: number, overlay: boolean) {
  const { min, max } = reviewWidthBounds(containerWidth, overlay)
  return Math.min(max, Math.max(min, Number.isFinite(width) ? width : 420))
}
