import { activeRuntimeId } from "@/stores/runtime"
import { RECONNECTED_EVENT, invoke, listen } from "../transport"
import type { ExtensionUiResponse, RpcResponse } from "../protocol"

/** Correlated request: resolves with the `response` record that carries our id. */
export function rpcRequest<T = unknown>(
  command: Record<string, unknown>,
  runtimeId = activeRuntimeId.value,
): Promise<RpcResponse<T>> {
  return invoke<RpcResponse<T>>("rpc_request", { command, runtimeId })
}

/** Image attachment of prompt / steer / follow_up commands (ImageContent). */
export interface RpcImage {
  type: "image"
  data: string
  mimeType: string
}

/** pi native `steer`: queue a message into the running agent; delivered after
 *  the current assistant turn finishes its tool calls, before the next LLM
 *  call. Extension commands are rejected (send those via `prompt`). */
export function rpcSteer(message: string, images?: RpcImage[], runtimeId = activeRuntimeId.value) {
  const command: Record<string, unknown> = { type: "steer", message }
  if (images?.length) command.images = images
  return rpcRequest<{ disposition?: import("../protocol").QueueDisposition }>(command, runtimeId)
}

/** pi native `follow_up`: queue a message to be processed right after the
 *  agent finishes (pi owns the queue, delivers it automatically and emits
 *  queue_update events). Extension commands are rejected (use `prompt`). */
export function rpcFollowUp(message: string, images?: RpcImage[], runtimeId = activeRuntimeId.value) {
  const command: Record<string, unknown> = { type: "follow_up", message }
  if (images?.length) command.images = images
  return rpcRequest<{ disposition?: import("../protocol").QueueDisposition }>(command, runtimeId)
}

/** Fire-and-forget write (extension_ui_response has no response record). */
export function rpcNotify(
  command: ExtensionUiResponse | Record<string, unknown>,
  runtimeId = activeRuntimeId.value,
): Promise<void> {
  return invoke<void>("rpc_notify", { command, runtimeId })
}

/** Subscribe to all non-response stdout records (agent events, extension UI requests). */
export function onPiEvent(handler: (event: Record<string, any>) => void): Promise<() => void> {
  return listen<Record<string, any>>("pi://event", e => handler(e.payload))
}

export function onPiExit(handler: (runtimeId?: string) => void): Promise<() => void> {
  return listen<{ runtimeId?: string }>("pi://exit", e => handler(e.payload.runtimeId))
}

export function onPiStderr(handler: (line: string, runtimeId?: string) => void): Promise<() => void> {
  return listen<{ line: string; runtimeId?: string }>("pi://stderr", e => handler(e.payload.line, e.payload.runtimeId))
}

/** SSH 重连 realpath 回绑（契约 §3.8）：后端把符号链接别名归一化后的路径
 *  重建为 `ssh://` 展示 URI 回报，前端据此更新项目展示（失败后端不发此事件）。 */
export function onSshPathBound(
  handler: (payload: { runtimeId?: string; project: string; path: string }) => void,
): Promise<() => void> {
  return listen<{ runtimeId?: string; project: string; path: string }>("pi://sshPathBound", e => handler(e.payload))
}

/** Remote transport re-established after an unexpected drop (never fired on
 *  desktop). Events during the gap are lost; handlers should re-sync state. */
export function onReconnected(handler: () => void): Promise<() => void> {
  return listen(RECONNECTED_EVENT, () => handler())
}
