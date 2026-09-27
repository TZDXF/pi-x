import type { IconifyJSON } from "@iconify/vue"
import { addCollection } from "@iconify/vue"

/**
 * 将 vscode-icons 图标集注册进 @iconify/vue 的离线存储（约 3.7MB）。
 * 动态 import 成独立 chunk 按需加载，不阻塞首屏；包主入口自带 IconifyJSON
 * 类型，直接引用即可，避免让 TS 解析 icons.json 本身。注册完成后，已挂载的
 * <Icon> 会自动补渲染，调用方无需等待。
 */
let started = false
export function loadVscodeIcons(): void {
  if (started) return
  started = true
  import("@iconify-json/vscode-icons")
    .then(({ icons }) => addCollection(icons as IconifyJSON))
    .catch((error) => console.warn("Failed to load vscode-icons collection:", error))
}
