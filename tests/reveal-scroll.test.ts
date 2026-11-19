import { test, expect } from "vitest"
import { overlapHeight, scrollOffsetFor, visibleRatio } from "@/lib/revealScroll"

/**
 * TZD-138 P2：把目标真正带进视口（而不是"发一次滚动指令就算完"）。
 *
 * 这里钉住判定与修正量的纯函数部分：可见比例、超长元素的"盖住视口中线"退化判定、
 * 居中所需的 `scrollTop` 增量（含上下边界夹取）。真实滚动/帧时序由
 * `e2e/prompt-collapse-locate.spec.ts` 的三内核布局断言覆盖。
 */
/**
 * TZD-138 P2：把目标真正带到目标位置（而不是"发一次滚动指令就算完"）。
 *
 * 这里钉住修正量的纯函数部分：居中/顶端对齐、可滚范围夹取、重叠比例。真实滚动与
 * 帧时序（含行高补偿抑制）由 `e2e/prompt-collapse-locate.spec.ts` 的三内核断言覆盖，
 * 行高补偿分支由 `tests/virtual-message.test.ts` 覆盖。
 */
const viewport = { top: 0, bottom: 550, height: 550 }

test("overlap and ratio count partial visibility", () => {
  expect(overlapHeight(viewport, { top: 100, bottom: 120, height: 20 })).toBe(20)
  // 半截在下面：只重叠 10px。
  expect(overlapHeight(viewport, { top: 540, bottom: 580, height: 40 })).toBe(10)
  expect(visibleRatio(viewport, { top: 540, bottom: 580, height: 40 })).toBeCloseTo(0.25)
  // 完全在视口外。
  expect(overlapHeight(viewport, { top: 700, bottom: 720, height: 20 })).toBe(0)
  expect(visibleRatio(viewport, { top: -100, bottom: -80, height: 20 })).toBe(0)
  // 退化尺寸不参与判定。
  expect(visibleRatio(viewport, { top: 0, bottom: 0, height: 0 })).toBe(0)
})

test("center alignment puts the target's middle on the viewport's middle", () => {
  // 目标中线 810，视口中线 275 → 需要向下滚 535。
  expect(scrollOffsetFor(viewport, { top: 800, bottom: 820, height: 20 }, 0, 10_000)).toBe(535)
  // 目标在上方：往上滚（目标中线 -390，视口中线 275 → -665）。
  expect(scrollOffsetFor(viewport, { top: -400, bottom: -380, height: 20 }, 1000, 10_000)).toBe(-665)
  // 已居中：0。
  expect(scrollOffsetFor(viewport, { top: 265, bottom: 285, height: 20 }, 500, 10_000)).toBe(0)
})

test("start alignment matches the pre-existing scrollToMessage behavior", () => {
  // 原有行为：`message.top - viewport.top - 24`。
  expect(
    scrollOffsetFor(viewport, { top: 300, bottom: 1300, height: 1000 }, 0, 10_000, { align: "start", margin: 24 }),
  ).toBe(276)
  // 已经在 24px 处：0 增量，不再写滚动位置。
  expect(
    scrollOffsetFor(viewport, { top: 24, bottom: 1024, height: 1000 }, 276, 10_000, { align: "start", margin: 24 }),
  ).toBe(0)
  // 长消息从上方离开视口时要把开头拉回来。
  expect(
    scrollOffsetFor(viewport, { top: -500, bottom: 500, height: 1000 }, 800, 10_000, { align: "start", margin: 24 }),
  ).toBe(-524)
})

test("offsets are clamped to the scrollable range", () => {
  expect(scrollOffsetFor(viewport, { top: -2000, bottom: -1980, height: 20 }, 100, 10_000)).toBe(-100)
  expect(scrollOffsetFor(viewport, { top: 9000, bottom: 9020, height: 20 }, 9000, 10_000)).toBe(1000)
})
