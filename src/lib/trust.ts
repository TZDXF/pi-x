import type { TrustStatus } from "@/api/piClient"

/**
 * 是否应向用户询问项目信任决定。
 *
 * pi 只在项目已经含有受保护资源（.pi 设置、mcp.json 等）时才要求决定
 * （needsDecision）；但资源也可能在会话运行中由 agent 新建，彼时不会再有
 * 提示，项目便处于“静默未信任”状态。PiX 因此把询问提前到首次进入项目：
 * 决定写入 pi 的 trust.json 后，今后出现的 .pi 资源会自动沿用该决定。
 * 全局策略为 always/never 时尊重用户的 pi 设置，不再询问。
 */
export function shouldAskProjectTrust(status: TrustStatus): boolean {
  if (status.needsDecision) return true
  return status.decision === null && (status.policy ?? "ask") === "ask"
}
