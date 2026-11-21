import { afterEach, expect, test, vi } from "vitest"
import {
  beginReveal,
  invalidateReveals,
  overlapHeight,
  revealElement,
  scrollOffsetFor,
  visibleRatio,
} from "@/lib/revealScroll"

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

test("a later reveal invalidates earlier ones inside the same viewport", async () => {
  // 同一视口里连续两次定位：先开始的必须让位，不能在等待结束后把新目标顶回去。
  const viewport = { scrollTop: 0, scrollHeight: 4000, clientHeight: 400 }
  expect(invalidateReveals).toBeTypeOf("function")
  invalidateReveals(viewport)
  // 换了对象就是换了视口：互不影响（token 存在 WeakMap 里按对象隔离）。
  expect(() => invalidateReveals({})).not.toThrow()
})

test("scroll offset helpers stay pure (no viewport mutation)", () => {
  const viewport = { scrollTop: 100, scrollHeight: 4000, clientHeight: 400 }
  scrollOffsetFor(
    { top: 0, bottom: 400, height: 400 },
    { top: 1200, bottom: 1220, height: 20 },
    viewport.scrollTop,
    viewport.scrollHeight - viewport.clientHeight,
  )
  expect(viewport.scrollTop).toBe(100)
})

/**
 * 定位是"滚 → 等停 → 复核 → 修正"的多轮过程，期间会多次写 `scrollTop`。用户在动画没结束时
 * 点了另一个目标时，旧定位必须立刻让位 —— 否则它后面的一轮修正会覆盖新目标（QA 的 P2）。
 * 这里用一个可控的假滚动容器复现"两次连续定位"。
 */
function fakeScroller(rows: { top: number; position: number }[]) {
  // rows 提供"目标的文档内位置"；视口高 400，滚动是即时的，但每轮都要等一个 rAF 才能复核。
  const viewport = {
    scrollTop: 0,
    scrollHeight: 8000,
    clientHeight: 400,
    scrollWrites: [] as number[],
    scrollTo(options: { top: number }) {
      viewport.scrollTop = Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, options.top))
      viewport.scrollWrites.push(viewport.scrollTop)
    },
    getBoundingClientRect: () => ({ top: 0, bottom: 400, height: 400 }),
  }
  const target = (position: number) => ({
    isConnected: true,
    getBoundingClientRect: () => {
      const top = position - viewport.scrollTop
      return { top, bottom: top + 20, height: 20 }
    },
  })
  return { viewport, target, rows }
}

test("the newer reveal wins even when the older one was already mid-flight", async () => {
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0))
  const { viewport, target } = fakeScroller([])
  // 先让第一次定位真的滚出一段（模拟"动画进行中"），再开始第二次。
  const row5 = target(600)
  const row65 = target(6000)
  const first = revealElement(viewport as unknown as HTMLElement, row5 as unknown as HTMLElement)
  await new Promise(resolve => setTimeout(resolve, 0))
  const second = revealElement(viewport as unknown as HTMLElement, row65 as unknown as HTMLElement)
  const results = await Promise.all([first, second])
  expect(results[1]).toBe(true)
  // 停在第二次点击的目标上；旧定位在作废后一次都没再写。
  expect(viewport.scrollTop).toBeCloseTo(5810, 0)
})

test("an in-flight reveal stops writing scroll once a newer reveal starts", async () => {
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0))
  const { viewport, target } = fakeScroller([])
  const row5 = target(600)
  const row65 = target(6000)
  // `revealElement` 每次都尝试把目标居中：第 5 条 → 400 左右；第 65 条 → 5810 左右
  // （目标行 6000..6020 的中线 6010 与视口中线 200 的差）。
  const first = revealElement(viewport as unknown as HTMLElement, row5 as unknown as HTMLElement)
  await Promise.resolve()
  const second = revealElement(viewport as unknown as HTMLElement, row65 as unknown as HTMLElement)
  const [firstResult, secondResult] = await Promise.all([first, second])
  // 旧定位作废：它不再写滚动位置，也不会宣称成功。
  expect(firstResult).toBe(false)
  expect(secondResult).toBe(true)
  // 最终停在最后一次点击的目标上，而不是被旧定位拉回第 5 条。
  expect(viewport.scrollTop).toBeCloseTo(5810, 0)
  expect(viewport.scrollWrites[viewport.scrollWrites.length - 1]).toBeCloseTo(5810, 0)
})

afterEach(() => vi.unstubAllGlobals())

/**
 * 跨入口竞态（TZD-138 第六轮）：请求身份必须在**发起定位的那一刻**取得，并贯穿后面的
 * `await`（重挂虚拟行、展开折叠正文、重算锚点）。否则"先发起、后恢复"的旧请求会被当成最新：
 * 时间线跳转与引用定位共用同一视口时，旧引用会把用户后来点的目标顶回去。
 */
test("a request taken before an await goes stale if a newer reveal starts meanwhile", async () => {
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0))
  const viewport = {} as HTMLElement
  const early = beginReveal(viewport)
  expect(early.isCurrent(), "the first request is current").toBe(true)
  // 模拟「用户又点了别处」：新请求在同一视口上开始。
  const later = beginReveal(viewport)
  expect(later.isCurrent()).toBe(true)
  expect(early.isCurrent(), "the earlier request is now stale").toBe(false)
})

test("an inherited request is respected: an older caller cannot re-acquire the viewport", async () => {
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => setTimeout(callback, 0))
  const { viewport, target } = fakeScroller([])
  const row5 = target(600)
  const row65 = target(6000)
  // 旧请求先取得身份，再**带着这个身份**去滚动：它必须立刻退出，不能写到第 5 条。
  const stale = beginReveal(viewport)
  beginReveal(viewport)
  const result = await revealElement(viewport as unknown as HTMLElement, row5 as unknown as HTMLElement, {
    request: stale,
  })
  expect(result, "a stale request never scrolls").toBe(false)
  expect(viewport.scrollWrites, "no scroll write from the stale request").toEqual([])
  // 同一次调用会沿用传来的身份：新请求照常生效。
  const fresh = beginReveal(viewport)
  const landed = await revealElement(viewport as unknown as HTMLElement, row65 as unknown as HTMLElement, {
    request: fresh,
  })
  expect(landed).toBe(true)
  expect(viewport.scrollTop).toBeCloseTo(5810, 0)
})
