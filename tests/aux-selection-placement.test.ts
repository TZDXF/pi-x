import { expect, test } from "vitest"
import { MENU_FLIP_THRESHOLD, MENU_GAP, MENU_MARGIN, menuPlacement } from "@/lib/selectionMenuPlacement"

/**
 * 浮层定位（TZD-103 P2-1 修复后）：横向钳制改用**实测宽度**，其余规则不变。
 *
 * 这里用真实像素算右缘，钉住"按钮整体在视口内"这条验收（1280px 视口右缘划词）。
 */
const viewport = { width: 1280, height: 800 }

/** 把 `left/top/bottom` 解析成浮层四边（用于断言右缘不越界）。 */
function box(style: { left: string; top?: string; bottom?: string }, width: number) {
  const left = Number.parseFloat(style.left)
  const right = left + width
  return { left, right }
}

test("a selection at the right edge keeps the whole menu inside the viewport", () => {
  // chat 模式两个横排按钮的实测宽度（真实渲染约 262px；这里用实测值模拟）。
  const width = 262
  // 划词末行行尾贴到视口右缘（1280）。
  const style = menuPlacement({ left: 1280, top: 300, bottom: 320 }, viewport, width)
  const { left, right } = box(style, width)
  expect(right).toBeLessThanOrEqual(viewport.width)
  expect(left).toBeGreaterThanOrEqual(MENU_MARGIN)
  // 旧的写死 168 会让 1280 的锚点被钳到 1112，右缘 1374 —— 这正是复核报的 1393px 溢出。
  expect(left).toBe(viewport.width - width - MENU_MARGIN)
  // 下方空间充足，不翻转。
  expect(style.top).toBe(`${320 + MENU_GAP}px`)
})

test("the clamp follows the measured width instead of a fixed constant", () => {
  const anchor = { left: 1200, top: 100, bottom: 120 }
  // 窄浮层（code 模式单按钮）只需让出自身宽度：同一锚点位置更靠右。
  const narrow = menuPlacement(anchor, viewport, 148)
  const wide = menuPlacement(anchor, viewport, 320)
  expect(Number.parseFloat(narrow.left)).toBeGreaterThan(Number.parseFloat(wide.left))
  for (const [style, width] of [
    [narrow, 148],
    [wide, 320],
  ] as const) {
    const { right } = box(style, width)
    expect(right).toBeLessThanOrEqual(viewport.width)
  }
})

test("a menu wider than the viewport sticks to the left margin instead of overflowing left", () => {
  const width = 1400
  const style = menuPlacement({ left: 900, top: 10, bottom: 30 }, viewport, width)
  expect(Number.parseFloat(style.left)).toBe(MENU_MARGIN)
})

test("flipping above still triggers on the same 48px threshold", () => {
  const bottom = viewport.height - (MENU_FLIP_THRESHOLD - 1)
  const flipped = menuPlacement({ left: 100, top: bottom - 16, bottom }, viewport, 262)
  expect(flipped.bottom).toBe(`${viewport.height - (bottom - 16) + MENU_GAP}px`)
  expect(flipped.top).toBeUndefined()
  // 刚好够 48px 时不翻转。
  const fits = menuPlacement({ left: 100, top: 100, bottom: viewport.height - MENU_FLIP_THRESHOLD }, viewport, 262)
  expect(fits.top).toBe(`${viewport.height - MENU_FLIP_THRESHOLD + MENU_GAP}px`)
  expect(fits.bottom).toBeUndefined()
})
