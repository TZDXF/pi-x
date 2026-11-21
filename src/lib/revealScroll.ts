/**
 * 程序化滚动到元素的工具（TZD-138 P2）：把目标**真正**带到目标位置，而不是"发一次滚动指令就算完"。
 *
 * 为什么不能只用 `scrollIntoView({ behavior: "smooth" })`：滚动动画进行中，其它组件仍可能
 * **直接写** `scrollTop`。`VirtualMessage` 的行高补偿就是这样（重挂后把 placeholder 的估算
 * 高度换成真实高度，并按差值补位）。一次这样的写入就会打断平滑滚动、动画停在半路，目标仍在
 * 视口外（QA 实测三内核的视口交集都是 0）。所以这里把"滚 → 等停 → 复核 → 修正"做成循环：
 * 首轮按调用方要求平滑滚动，之后每轮重新读取目标真实位置并即时修正，直到它落在要求的位置。
 *
 * 调用方还需要在这段时间里暂停会打架的高度补偿（见 `Conversation` 的 `revealLock`）。
 *
 * 同一视口上的定位是**互斥**的：新定位一开始旧定位就作废（`invalidateReveals` /
 * `startReveal`），并且每次写 `scrollTop` 之前都重新校验 token —— 用户在动画没结束时
 * 点了另一个目标时，只有最后一次点击会生效，旧定位不会再把它顶回去。
 *
 * 两种对齐方式：
 * - `center`（默认）：目标竖直居中 —— 用于小目标，例如划词引用的徽标；
 * - `start`：目标顶端贴视口顶端（留 `margin` 像素）—— 用于"跳到某条消息"，
 *   与原有 `scrollToMessage` 的行为一致（长消息不能被居中，否则会跳过它的开头）。
 */

/** 视口与元素都按视口坐标（`getBoundingClientRect`）计算，与滚动容器内部偏移无关。 */
export interface RevealRect {
  top: number
  bottom: number
  height: number
}

/** 目标与视口的竖直交叠高度（0 表示完全在视口外）。 */
export function overlapHeight(viewport: RevealRect, target: RevealRect): number {
  return Math.max(0, Math.min(target.bottom, viewport.bottom) - Math.max(target.top, viewport.top))
}

/** 目标与视口相交的比例（0 表示完全在视口外）。 */
export function visibleRatio(viewport: RevealRect, target: RevealRect): number {
  if (target.height <= 0 || viewport.height <= 0) return 0
  return Math.min(1, overlapHeight(viewport, target) / target.height)
}

/** 对齐目标位置所需的 `scrollTop` 增量（正数表示向下滚，结果已夹在 `[0, max]` 内）。 */
export function scrollOffsetFor(
  viewport: RevealRect,
  target: RevealRect,
  scrollTop: number,
  max: number,
  options: { align?: "center" | "start"; margin?: number } = {},
): number {
  const margin = options.margin ?? 0
  const desiredTop =
    options.align === "start"
      ? target.top - viewport.top - margin
      : (target.top + target.bottom) / 2 - (viewport.top + viewport.bottom) / 2
  const desired = Math.max(0, Math.min(max, scrollTop + desiredTop))
  return desired - scrollTop
}

/**
 * 等滚动停下来：连续 `stableFrames` 帧 `scrollTop` 不变即视为停稳。
 * 用 rAF 采样而不是定时器：滚动动画按帧推进，帧间采样才能看出"还在动"。
 */
export function waitForScrollSettle(
  viewport: { scrollTop: number },
  options: { timeoutMs?: number; stableFrames?: number; cancelled?: () => boolean } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 900
  const stableFrames = options.stableFrames ?? 3
  return new Promise(resolve => {
    const started = performance.now()
    let last = viewport.scrollTop
    let stable = 0
    const tick = () => {
      // 被新定位顶替后立即返回，不再白等到超时（调用方随后会作废整轮修正）。
      if (options.cancelled?.()) return resolve()
      const now = viewport.scrollTop
      stable = Math.abs(now - last) < 1 ? stable + 1 : 0
      last = now
      if (stable >= stableFrames || performance.now() - started >= timeoutMs) resolve()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

/** 等一帧（`requestAnimationFrame`；没有 rAF 的环境直接继续）。 */
export function nextFrame(): Promise<void> {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve())
    else resolve()
  })
}

/**
 * 同一个视口里的定位是**互斥**的：新定位一开始，旧的立即作废。
 *
 * 为什么需要：定位是"滚 → 等停 → 复核 → 修正"的多轮过程，期间会**多次写** `scrollTop`。
 * 用户在动画没结束时点了另一个目标（时间线的"跳转到第 N 次提问"很容易连点），
 * 旧定位在那之后的一轮即时修正就会把新目标顶掉 —— 表现为"第二次点击赢了又输"。
 * 因此每个视口维护一个序号：每次定位领取自己的 token，之后**每一次滚动写入前**都比对
 * 序号，过期就立刻退出（返回 `false`），不再碰滚动位置。
 */
const revealTokens = new WeakMap<object, { seq: number }>()

function registryFor(viewport: object): { seq: number } {
  const existing = revealTokens.get(viewport)
  if (existing) return existing
  const created = { seq: 0 }
  revealTokens.set(viewport, created)
  return created
}

/**
 * 一次定位请求的身份。**必须在用户发起定位的那一刻取得**（不是等到真正滚动时才取）：
 * 重挂、展开、锚点重算都是 `await`，期间用户可能又点了别的目标；如果等到最后一刻才领
 * token，先发起、后恢复的旧请求会被当成"最新"，反把新目标顶掉（QA 实测跨入口三内核复现）。
 */
export interface RevealRequest {
  /** 该请求是否仍是最新的定位（被更新的请求作废后恒为 `false`）。 */
  isCurrent(): boolean
}

/** 让该视口上所有在途定位作废（不含即将开始的新定位）。 */
export function invalidateReveals(viewport: object): void {
  const registry = revealTokens.get(viewport)
  if (registry) registry.seq++
}

/**
 * 在**发起定位的那一刻**为该视口取得请求身份：同一视口上的旧请求立刻作废。
 * 之后把同一个 `RevealRequest` 贯穿重挂、展开、锚点重算与最终滚动，
 * 每一步都先问 `isCurrent()`；已作废的请求必须**终止**，不能改走别的回退路径。
 */
export function beginReveal(viewport: object): RevealRequest {
  const registry = registryFor(viewport)
  registry.seq += 1
  const token = registry.seq
  return { isCurrent: () => registry.seq === token }
}

export interface RevealOptions {
  /** 首轮是否平滑滚动（之后一律即时修正）。 */
  animated?: boolean
  /** 轮数上限。 */
  attempts?: number
  align?: "center" | "start"
  margin?: number
  /**
   * 调用方在发起定位时取得的请求身份。给了就用它（不再自作主张领新 token），
   * 这样"先发起、后恢复"的旧请求不会把后来的目标顶掉。不给则在本函数内取得。
   */
  request?: RevealRequest
  /**
   * 每轮修正是否允许写滚动。返回 `false` 时**立即收手**（不再写、也不再宣称到位）。
   *
   * 用途：读者正按住/拖动视口时（触摸手势待定），任何应用侧的修正写入都会和手势抢位置，
   * 也会干扰 TZD-135 的"谁在滚"归因判定。此时宁可停在这、留给读者接管，也不要抢。
   */
  canCorrect?: () => boolean
  /**
   * 自己执行这一次滚动写入（默认是 `viewport.scrollTo`）。
   *
   * 调用方改成 `viewport.scrollTop = top` 时，写入会被 `observeScrollWrites` 记录，
   * 由此产生的 scroll 事件也能归因给应用（见 `lib/scrollWrites`）；用 `scrollTo()` 的
   * 修正写入无法被记录，会落到"读者向下滚到底"的判定上，错误地重新吸底（TZD-135 回归）。
   */
  write?: (top: number) => void
}

/**
 * 把元素滚到要求的位置并**验证**结果，返回是否最终到位。
 *
 * - 首轮按 `animated` 决定平滑还是即时，之后一律即时（修正距离通常很小，平滑会二次抖动）；
 * - 每轮都重新读取位置：滚动期间虚拟行可能重挂/卸载，目标会跟着平移；
 * - 轮次用尽仍未到位时返回 `false`，调用方据此如实记录，而不是假装成功。
 */
export async function revealElement(
  viewport: HTMLElement,
  target: HTMLElement,
  options: RevealOptions = {},
): Promise<boolean> {
  /**
   * 轮数上限：冷跳历史目标时，被重挂出来的虚拟行会陆续用真实高度替换估算高度，
   * 每一轮目标的真实位置都会再下一城（4 轮常常还没到）；这里给足余量，并在每轮之间
   * 等布局稳定，避免"写入一次就收工"却在视口外。
   */
  const attempts = options.attempts ?? 12
  // 用调用方在发起定位时取得的身份；没有则现在取得（同一视口上的旧定位立刻作废）。
  const request = options.request ?? beginReveal(viewport)
  const current = () => request.isCurrent()
  const max = () => Math.max(0, viewport.scrollHeight - viewport.clientHeight)
  const offset = () => {
    if (!target.isConnected) return Number.POSITIVE_INFINITY
    return scrollOffsetFor(
      viewport.getBoundingClientRect(),
      target.getBoundingClientRect(),
      viewport.scrollTop,
      max(),
      options,
    )
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    // 每次写入前都校验：被更新的定位顶替后立刻退出，绝不再动滚动位置。
    if (!current() || !target.isConnected) return false
    const delta = offset()
    // 已经在要求的位置（亚像素误差内）：不必发滚动指令。
    if (Math.abs(delta) < 1) return true
    if (!current()) return false
    // 读者正在接管（手势待定）：收手，不再抢滚动位置。
    if (options.canCorrect && !options.canCorrect()) return false
    const nextTop = viewport.scrollTop + delta
    if (options.write) options.write(nextTop)
    else
      viewport.scrollTo({
        top: nextTop,
        behavior: attempt === 0 && options.animated ? "smooth" : "instant",
      })
    await waitForScrollSettle(viewport, { cancelled: () => !current() })
    // 等两帧让行高测量/重挂的布局变化落定，下一轮读到的是真实位置而不是中间态。
    await nextFrame()
    await nextFrame()
  }
  if (!current()) return false
  // 轮次用尽仍不到位时，最后再即时写一次（不再滚动动画），并如实返回是否真的到了。
  const finalDelta = offset()
  if (Math.abs(finalDelta) >= 1 && (!options.canCorrect || options.canCorrect())) {
    const nextTop = viewport.scrollTop + finalDelta
    if (options.write) options.write(nextTop)
    else viewport.scrollTo({ top: nextTop, behavior: "instant" })
    await waitForScrollSettle(viewport, { cancelled: () => !current() })
    await nextFrame()
  }
  return current() && Math.abs(offset()) < 1
}
