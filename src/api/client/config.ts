import { open as chooseDirectory } from "@tauri-apps/plugin-dialog"
import { invoke, isDesktop } from "../transport"
import type { UpdateChannel } from "./updates"

export interface TrustStatus {
  projectPath: string
  parentPath: string | null
  hasTrustRequiringResources: boolean
  decision: boolean | null
  needsDecision: boolean
}

export interface ModelRef {
  provider: string
  modelId: string
}

export interface AppConfig {
  piPath?: string
  lastProject?: string
  /** 应用自身更新通道（app_update.rs），缺省为 stable */
  updateChannel?: UpdateChannel
  /** Default model for auxiliary features such as title generation; independent of pi's default model. */
  defaultModel?: ModelRef
  /** Custom title model; ignored while titleFollowMain is set. */
  titleModel?: ModelRef
  /** Title generation follows the default model instead of titleModel. */
  titleFollowMain?: boolean
  /** Translation model for package resource content. */
  translationModel?: ModelRef
  /** 无项目会话的工作目录；缺省为 `~/.pix/workspace`。 */
  projectlessDir?: string
  /** 新会话创建 worktree 的父目录；支持绝对路径与相对项目的相对路径，缺省为项目根目录下的 `.pix-worktrees`。 */
  worktreeDir?: string
  /** PiX 内置文件变更插件；缺省为启用。 */
  builtinFileChanges?: boolean
  /** PiX 内置延迟发送插件；缺省为启用。 */
  builtinDelayedSend?: boolean
}

export interface PiSettings {
  defaultProvider?: string | null
  defaultModel?: string | null
  defaultThinkingLevel?: import("../protocol").ThinkingLevel
  modelThinkingLevels?: Record<string, import("../protocol").ThinkingLevel>
  skills: string[]
  /** pi 全局 settings.json 的 `retry` 段。 */
  retry: { maxRetries: number }
  /** pi 全局 settings.json 的 `followUpMode`：排队跟进消息的投递节奏。 */
  followUpMode?: import("../protocol").QueueDeliveryMode
}
export const getPiSettings = () => invoke<PiSettings>("pi_settings_get")
export const savePiSettings = (
  settings: Partial<Pick<PiSettings, "defaultProvider" | "defaultModel" | "skills" | "followUpMode">> & {
    retry?: { maxRetries: number }
  },
) => invoke<void>("pi_settings_save", { settings })

/** 原生托盘菜单读不到 webview 的语言包，由前端把当前语言的菜单文案同步给 Rust。 */
export function setTrayLabels(show: string, quit: string): Promise<void> {
  if (!isDesktop) return Promise.resolve()
  return invoke<void>("set_tray_labels", { showLabel: show, quitLabel: quit })
}

export const getConfig = () => invoke<AppConfig>("app_config_get")

export const saveConfig = (config: AppConfig) => invoke<void>("app_config_save", { config })

export interface ProjectlessDirInfo {
  /** 实际使用的工作目录（已规范化）。 */
  dir: string
  /** 默认目录 `~/.pix/workspace`，用于设置页展示与「恢复默认」。 */
  defaultDir: string
  /** 当前是否使用默认目录（未配置或配置即默认值）。 */
  isDefault: boolean
}

/** 解析无项目会话目录并由后端按需创建；未配置时返回 `~/.pix/workspace`。 */
export const resolveProjectlessDir = () => invoke<ProjectlessDirInfo>("projectless_dir_resolve")

/** 桌面端目录选择器；浏览器/远程返回 null（无法访问主机文件系统）。 */
export async function chooseDirectoryPath(title: string): Promise<string | null> {
  if (!isDesktop) return null
  const picked = await chooseDirectory({ directory: true, title })
  return typeof picked === "string" ? picked : null
}

export interface GlobalPromptFile {
  fileName: string
  content: string
  exists: boolean
}

export const listGlobalPrompts = () => invoke<GlobalPromptFile[]>("global_prompt_list")

export const saveGlobalPrompt = (fileName: string, prompt: string) =>
  invoke<void>("global_prompt_save", { fileName, prompt })

export const trustStatus = (project: string) => invoke<TrustStatus>("trust_status", { project })

export const trustSave = (project: string, trusted: boolean, trustParent: boolean) =>
  invoke<unknown>("trust_save", { project, trusted, trustParent })
