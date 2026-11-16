/**
 * 远程连接多后端 UI 纯逻辑（docs/plans/remote-backends-contract.md §4.1/§4.4/§5.4）。
 *
 * 供 SshSettings / CreateProjectDialog 共用：kind 选择项（平台守卫 + 不可用态）
 * 与 per-kind 表单字段显隐。零依赖、可注入枚举结果，便于单测（契约 §6）。
 */
import type { RemoteKind } from "@/lib/ssh"

/** 连接表单的字段键；顺序即渲染顺序。 */
export type RemoteFormField = "host" | "port" | "user" | "keyPath" | "distro" | "container"

/**
 * 各后端的表单字段（多后端契约 §5.4）：SSH 保留 host/port/user/keyPath；
 * WSL 为 distro 下拉 + 可选 user；Docker 仅 container 下拉。
 * 凭据字段 keyPath 仅 SSH 有（WSL/Docker 复用本机身份，契约 §3.1）。
 */
export function remoteFormFields(kind: RemoteKind): RemoteFormField[] {
  switch (kind) {
    case "ssh":
      return ["host", "port", "user", "keyPath"]
    case "wsl":
      return ["distro", "user"]
    case "docker":
      return ["container"]
  }
}

export interface RemoteKindOption {
  kind: RemoteKind
  /** 入口置灰：枚举结果确认不可用（契约 §4.4「不可用态」）。 */
  disabled: boolean
  /** 置灰原因的 i18n 键；可用或尚未枚举（null）时无提示。 */
  hintKey: string | null
}

/**
 * kind 选择器的可见项：WSL 仅 Windows 可见（平台守卫，契约 §4.1）；
 * 枚举结果 available=false 的后端入口置灰并提示（null = 尚未枚举/枚举中，不置灰）。
 */
export function remoteKindOptions(options: {
  isWindows: boolean
  wslAvailable: boolean | null
  dockerAvailable: boolean | null
}): RemoteKindOption[] {
  const entries: RemoteKindOption[] = [{ kind: "ssh", disabled: false, hintKey: null }]
  if (options.isWindows)
    entries.push({ kind: "wsl", disabled: options.wslAvailable === false, hintKey: "ssh.wslUnavailable" })
  entries.push({ kind: "docker", disabled: options.dockerAvailable === false, hintKey: "ssh.dockerUnavailable" })
  return entries
}
