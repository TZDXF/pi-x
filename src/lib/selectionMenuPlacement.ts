/**
 * 划词浮层的位置计算（纯函数，TZD-103 修订）。
 *
 * 为什么单独立出来：浮层的锚点/翻转/钳制是**唯一允许按实测宽度调整**的定位逻辑
 * （右缘溢出是质量复核的 P2-1）。把它抽成无 DOM 依赖的纯函数，就可以用真实像素
 * 断言"按钮右缘 ≤ 视口宽度"，而不必依赖浏览器快照。
 *
 * 1. 锚点是 `selectionEndRect`（多行选区取最后一行行尾），浮层贴其右缘；
 * 2. 纵向按浮层实测高度决定翻转；两侧都放不下时钳制在视口内，保证动作可达；
 * 3. 横向：左缘不早于 `margin`，右缘不超出视口（按浮层实测宽度钳制）。
 */
export interface MenuAnchor {
  left: number
  top: number
  bottom: number
}

export interface MenuViewport {
  width: number
  height: number
}

export interface MenuPlacement {
  left: string
  top?: string
  bottom?: string
  /** 便于直接交给模板的 `:style`（与 Vue 的 CSSProperties 兼容）。 */
  [key: string]: string | undefined
}

/** 浮层与锚点/视口边缘的间距（既有实现的 4px + 8px 边距，未改）。 */
export const MENU_GAP = 4
export const MENU_MARGIN = 8
/** 视口下方剩余高度小于它时翻到上方（既有阈值，未改）。 */
export const MENU_FLIP_THRESHOLD = 48

/**
 * 计算浮层的 fixed 定位样式。
 *
 * @param menuWidth 浮层**实测**宽度（首次渲染前拿不到时传估计值）。
 * @param menuHeight 浮层实测高度；缺省保留单行菜单原来的 48px 翻转阈值。
 */
export function menuPlacement(
  anchor: MenuAnchor,
  viewport: MenuViewport,
  menuWidth: number,
  menuHeight?: number,
): MenuPlacement {
  // 宽度可能大于可用宽度（窄窗口）：此时左缘固定 8px，宁可压住也不左溢。
  const maxLeft = Math.max(MENU_MARGIN, viewport.width - menuWidth - MENU_MARGIN)
  const left = Math.max(MENU_MARGIN, Math.min(anchor.left, maxLeft))
  const height = menuHeight ?? MENU_FLIP_THRESHOLD - MENU_GAP - MENU_MARGIN
  const requiredBelow = height + MENU_GAP + MENU_MARGIN
  if (viewport.height - anchor.bottom >= requiredBelow) {
    return { left: `${left}px`, top: `${anchor.bottom + MENU_GAP}px` }
  }
  // 上方能完整容纳时才翻转；否则（例如很矮的视口）直接纵向钳制，避免顶部出现负坐标。
  if (anchor.top - MENU_GAP - height >= MENU_MARGIN) {
    return { left: `${left}px`, bottom: `${viewport.height - anchor.top + MENU_GAP}px` }
  }
  const top = Math.max(MENU_MARGIN, Math.min(anchor.bottom + MENU_GAP, viewport.height - height - MENU_MARGIN))
  return { left: `${left}px`, top: `${top}px` }
}
