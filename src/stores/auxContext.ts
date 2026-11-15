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
 * 本文件刻意不引入 Vue：它只是两个 Set/Map，采集器由调用方注入，单测可以直接
 * 加载（不需要 Pinia/传输层）。
 */
import type { AuxContextCollectResult } from "@/lib/auxContextCollect"

const injected = new Set<string>()

/** 是否已经为这个 aux 实例拼过一次父上下文（诊断/测试用）。 */
export function auxParentContextInjected(runtimeId: string): boolean {
  return injected.has(runtimeId)
}

/** 关闭实例时清掉记账（`closeAux` 的销毁顺序里的一步）。 */
export function clearAuxParentContext(runtimeId: string) {
  injected.delete(runtimeId)
}

/** 仅测试用：清空全部记账。 */
export function resetAuxParentContextForTest() {
  injected.clear()
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
 * 记账在校验之前写入：并发的两次提交（连按回车）只有一次能拿到块，不会各拼一份。
 * 三类情形都走同一条出口：
 * - 确实无已提交输入 → 内文是顶部提示（"只带选段 + 顶部提示"，不报错）；
 * - 已提交但文件暂不可读 / 读取竞态 → 采集器内部回落 `get_entries`，拿到真实内容；
 * - 采集失败（三路全挂）→ 仍是顶部提示，但 `errors` 会带原因供诊断。
 */
export async function claimAuxParentContext(
  runtimeId: string,
  options: ClaimAuxParentContextOptions,
): Promise<string | null> {
  if (injected.has(runtimeId)) return null
  injected.add(runtimeId)
  if (options.hasUserEntry()) return null
  const result = await options.collect()
  return result.inner
}
