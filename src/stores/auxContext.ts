/**
 * aux 父上下文**只注入首轮**的模块级记账（`docs/aux-chat-spec.md` §3）。
 *
 * 为什么是模块级：aux 实例活在 `stores/auxChat.ts` 的注册表里、活过 `ChatView`
 * 重挂载；如果把"已注入"记在面板（组件）上，切一次父会话再切回来就能再注入一次，
 * 用户会为同一段父上下文付两次全价 token。所以按 aux `runtimeId` 记，关闭即清。
 *
 * 两条独立判据（任一成立就不拼块）：
 * 1. 本实例已经拼过一次（`injected`）；
 * 2. aux 会话里**已经有 user 条目** —— 即使记账丢了（重载、并发提交），历史里已有
 *    提问就不是首轮了。
 *
 * **并发首轮按先来先得串行**：同一 aux 的第一个提交在飞时，后来的提交**等它**再走
 * 自己的路径。否则先发者还在采集、后发者已经带着"无块"的消息先落地，用户在对话区
 * 看到的第一条是没有父上下文的（块反而随后才到）。后续轮次不排队：`injected` 已命中，
 * 直接返回、零等待。
 *
 * 本文件刻意不引入 Vue：它只是 Set/Map 与一条 Promise 链，采集器由调用方注入，
 * 单测可以直接加载（不需要 Pinia/传输层）。
 */
import type { AuxContextCollectResult } from "@/lib/auxContextCollect"

const injected = new Set<string>()
/** 每个 aux 实例**在飞**的首轮采集（并发提交的串行点）。 */
const inflight = new Map<string, Promise<string | null>>()

/** 是否已经为这个 aux 实例拼过一次父上下文（诊断/测试用）。 */
export function auxParentContextInjected(runtimeId: string): boolean {
  return injected.has(runtimeId)
}

/** 关闭实例时清掉记账（`closeAux` 的销毁顺序里的一步）。 */
export function clearAuxParentContext(runtimeId: string) {
  injected.delete(runtimeId)
  inflight.delete(runtimeId)
}

/** 仅测试用：清空全部记账。 */
export function resetAuxParentContextForTest() {
  injected.clear()
  inflight.clear()
}

export interface ClaimAuxParentContextOptions {
  /** 读取 aux 会话是否已有 user 条目（**调用时**求值，不能是打开面板时的快照）。 */
  hasUserEntry: () => boolean
  /** 采集父会话已提交分支（`lib/auxContextCollect.ts`）。 */
  collect: () => Promise<AuxContextCollectResult>
}

/**
 * 首轮取父上下文：返回折叠块**内文**（不含标签），`null` 表示本轮不拼块。
 *
 * 顺序语义（先来先得）：
 * - 第一个提交成为"领头者"：立刻占账、执行采集，拿到块后返回；
 * - 同时在飞的其他提交**await 领头者的 Promise** 之后返回 `null` —— 它们不重复
 *   拼块（同一段父上下文只该进一次上下文），但因为等过领头者，发送顺序与提交顺序
 *   一致，不会出现"后发者先落地"。
 * - 已经拼过的实例（后续轮次）直接返回 `null`，不排队、零等待。
 *
 * 三类情形都走同一条出口：
 * - 确实无已提交输入 → 内文是顶部提示（"只带选段 + 顶部提示"，不报错）；
 * - 已提交但文件暂不可读 / 读取竞态 → 采集器内部回落 `get_entries`，拿到真实内容；
 * - 采集失败（三路全挂）→ 仍是顶部提示，但 `errors` 会带原因供诊断。
 *
 * 采集本身抛错时**不吞**：领头者会拿到 rejected Promise，调用方（发送路径）据此
 * 如实降级（记录日志后不带块发送），而不是让先发者"无声无块"地消失。
 */
export async function claimAuxParentContext(
  runtimeId: string,
  options: ClaimAuxParentContextOptions,
): Promise<string | null> {
  if (injected.has(runtimeId)) {
    // 后续轮次：不排队；只等已经开始的领头采集落地，保证发送顺序不乱。
    const running = inflight.get(runtimeId)
    if (running) await running.catch(() => null)
    return null
  }
  injected.add(runtimeId)
  const leading = (async () => {
    if (options.hasUserEntry()) return null
    const result = await options.collect()
    return result.inner
  })()
  inflight.set(runtimeId, leading)
  try {
    return await leading
  } finally {
    if (inflight.get(runtimeId) === leading) inflight.delete(runtimeId)
  }
}
