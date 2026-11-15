/**
 * aux（辅助对话）事件的分发接口 —— 由 `stores/auxChat.ts` 在加载时登记。
 *
 * 为什么用注册表而不是直接 import：`lib/workspaceRuntime.ts` 需要把 aux 的
 * `pi://event` / `pi://exit` / stderr 分给 aux 自己的 store，但直接 import 会把
 * `stores/session` → `api/piClient` → `api/transport`（依赖 `sessionStorage`）拖进
 * 只测事件分发的 Node 环境。这里的接口是**纯类型**，运行时只有一个函数指针。
 */
import type { SessionActivity } from "@/lib/workspaceState"

export interface AuxEventSink {
  /** 该 runtime 是否已关闭（墓碑命中 ⇒ 迟到事件一律丢弃）。 */
  isClosed(runtimeId: string): boolean
  /** 是否有存活的 aux session store（绝不按需重建）。 */
  hasSession(runtimeId: string): boolean
  /** 把事件交给 aux 自己的 session store。 */
  handleEvent(runtimeId: string, event: Record<string, any>): void
  resolveRequest(runtimeId: string, id: string): void
  handleRequest(runtimeId: string, request: unknown): void
  restoreRequests(runtimeId: string, requests: unknown[]): void
  pushStderr(runtimeId: string, line: string): void
  /** `pi://exit` 的收尾（不改主会话的 phase/project 选择）。 */
  onExit(runtimeId: string, activity?: SessionActivity): void
}

let sink: AuxEventSink | null = null

export function registerAuxEventSink(next: AuxEventSink | null) {
  sink = next
}

export function auxEventSink(): AuxEventSink | null {
  return sink
}
