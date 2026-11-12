/** 项目文件树的最窄宽度：够放下图标、名称与缩进。 */
export const FILE_TREE_MIN_WIDTH = 160
/** 文件树拖到最宽时仍为内容区（预览）保留的最小宽度。 */
export const FILE_PREVIEW_MIN_WIDTH = 280
/** 默认文件树宽度：不再占满面板，把空间留给常开的内容区。 */
export const FILE_TREE_DEFAULT_WIDTH = 240

/**
 * 文件树可拖拽范围：以容器可用宽度为边界，内容区始终保留最小宽度。
 */
export function fileTreeWidthBounds(containerWidth: number) {
  const available = Math.max(0, containerWidth)
  const max = Math.max(0, available - FILE_PREVIEW_MIN_WIDTH)
  return { min: Math.min(FILE_TREE_MIN_WIDTH, max), max }
}

export function clampFileTreeWidth(width: number, containerWidth: number) {
  const { min, max } = fileTreeWidthBounds(containerWidth)
  return Math.min(max, Math.max(min, Number.isFinite(width) ? width : FILE_TREE_DEFAULT_WIDTH))
}
