import type { IconifyJSON } from "@iconify/vue"
import { addCollection, setCustomIconsLoader } from "@iconify/vue"

/**
 * vscode-icons 图标集（约 3.7MB）离线加载。
 *
 * 图标集动态 import 成独立 chunk 按需加载，不阻塞首屏；结果为共享 Promise，
 * 预加载与离线加载器复用同一份数据。包主入口自带 IconifyJSON 类型，直接引用
 * 即可，避免让 TS 解析 icons.json 本身。
 */

let collectionPromise: Promise<IconifyJSON> | null = null
function loadCollection(): Promise<IconifyJSON> {
  collectionPromise ??= import("@iconify-json/vscode-icons").then(({ icons }) => icons as IconifyJSON)
  return collectionPromise
}

// 注册离线加载器：<Icon> 请求 vscode-icons: 前缀且本地尚未缓存时，从打包产物
// 内的图标集解析，绝不请求 api.iconify.design。模块加载即注册，早于任何 <Icon>
// 挂载，因此从首个图标渲染起就不产生网络请求。
setCustomIconsLoader(() => loadCollection(), "vscode-icons")

let started = false
/** 预加载图标集并整体注册进离线存储，注册后渲染无需再经过加载器 */
export function loadVscodeIcons(): void {
  if (started) return
  started = true
  loadCollection()
    .then(icons => addCollection(icons))
    .catch(error => console.warn("Failed to load vscode-icons collection:", error))
}
